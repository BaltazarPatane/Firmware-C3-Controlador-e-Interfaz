#include "bridge_core.hpp"
#include "bridge_json.hpp"
#include "bridge_outbox.hpp"
#include "bridge_protocol.hpp"
#include "cJSON.h"
#include "driver/uart.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_spiffs.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "network_policy.hpp"
#include "router_policy.hpp"
#include "camera_registry.hpp"
#include "lwip/ip4_addr.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#include "socket_io.hpp"
#include <array>
#include <atomic>
#include <cassert>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <sys/socket.h>

static const char *TAG = "marlin_bridge";
static constexpr uart_port_t UART_PORT = UART_NUM_1;
static httpd_handle_t server = nullptr;
static QueueHandle_t requests, uart_events, file_requests;
static bridge::Outbox outbox;
static bridge::RouterPolicy network;
static bridge::CameraRegistry camera_registry;
static std::atomic<bool> wifi_ready{false};
static std::atomic<uint32_t> wifi_epoch{0}, wifi_disconnects{0};
static uint32_t local_address = 0, local_mask = 0;
struct Client {
  std::atomic<uint32_t> id{0};
  std::atomic<int> fd{-1};
  std::atomic<int64_t> last{0};
  std::atomic<uint32_t> failed{0};
  std::atomic<uint32_t> dropped_console{0};
};
static std::array<Client, bridge::MAX_CLIENTS> clients;
static std::atomic<uint32_t> next_session{1};
static uint32_t boot_id;
static bridge::Core *core =
    nullptr; // Read only by publish(), on the UART task.
static uint64_t now_ms() {
  return static_cast<uint64_t>(esp_timer_get_time() / 1000);
}
static Client *find_client(uint32_t id) {
  for (auto &c : clients)
    if (c.id.load() == id && id)
      return &c;
  return nullptr;
}
using Op = bridge::Op;
using Request = bridge::Request;
using Outbound = bridge::NetworkMessage;
struct Session {
  uint32_t id;
  size_t slot;
};

static void publish(const bridge::Event &e) {
  for (auto &client : clients) {
    const uint32_t session = client.id.load();
    if (!session || (e.session && e.session != session))
      continue;
    cJSON *o = bridge::makeMessage(*core, e, session, boot_id, network.state());
    if (!o) {
      client.failed.store(session);
      continue;
    }
    if (e.type == "status") {
      cJSON_AddNumberToObject(o, "droppedConsoleLines", client.dropped_console.load());
      const auto camera = camera_registry.snapshot(now_ms());
      const auto base = camera.baseUrl();
      cJSON_DeleteItemFromObject(o, "cameraUrl");
      cJSON_AddStringToObject(o, "cameraUrl", base.empty() ? "" : (base + "/capture").c_str());
      cJSON_DeleteItemFromObject(o, "cameraAssociated");
      cJSON_AddBoolToObject(o, "cameraAssociated", camera.available);
      cJSON_DeleteItemFromObject(o, "version");
      cJSON_AddStringToObject(o, "version", "4.1.3-direct");
    }
    char *json = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (!json) {
      client.failed.store(session);
      continue;
    }
    Outbound item{session, json};
    cJSON_free(json);
    const bool telemetry = e.type == "rx" || e.type == "historyRx" ||
                           e.type == "historyTx" || e.type == "tx";
    const auto kind = e.type == "status" ? bridge::NetworkKind::Status
                      : telemetry        ? bridge::NetworkKind::Telemetry
                                         : bridge::NetworkKind::Control;
    if (!outbox.push(std::move(item), kind) && client.id.load() == session) {
      if (telemetry)
        client.dropped_console.fetch_add(1);
      else
        client.failed.store(session);
    }
  }
}
static void send_work(void *arg) {
  std::unique_ptr<Outbound> item(static_cast<Outbound *>(arg));
  Client *c = item ? find_client(item->session) : nullptr;
  if (!c)
    return;
  const int fd = c->fd.load();
  if (fd < 0 || httpd_ws_get_fd_info(server, fd) != HTTPD_WS_CLIENT_WEBSOCKET)
    return;
  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = reinterpret_cast<uint8_t *>(item->json.data());
  frame.len = item->json.size();
  if (httpd_ws_send_frame_async(server, fd, &frame) != ESP_OK)
    c->failed.store(item->session);
}
static void network_task(void *) {
  for (;;) {
    if (auto message = outbox.pop()) {
      auto *item = new Outbound(std::move(*message));
      if (!server || httpd_queue_work(server, send_work, item) != ESP_OK) {
        if (auto *c = find_client(item->session))
          c->failed.store(item->session);
        delete item;
      }
    } else
      vTaskDelay(pdMS_TO_TICKS(2));
  }
}
static void close_work(void *arg) {
  const auto id = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(arg));
  if (auto *c = find_client(id)) {
    const int fd = c->fd.load();
    if (fd >= 0)
      shutdown(fd, SHUT_RDWR);
  }
}
static void serial_task(void *) {
  bridge::Core engine(publish, [](const std::string &s) {
    return uart_write_bytes(UART_PORT, s.data(), s.size()) ==
           static_cast<int>(s.size());
  });
  core = &engine;
  std::array<uint32_t, bridge::MAX_CLIENTS> attached = {}, closing = {};
  std::string line;
  line.reserve(384);
  bool dropping = false;
  uint64_t last_status = 0;
  for (;;) {
    const uint64_t now = now_ms();
    for (size_t i = 0; i < clients.size(); ++i) {
      auto &client = clients[i];
      uint32_t id = client.id.load();
      if (attached[i] && attached[i] != id) {
        engine.detach(attached[i]);
        attached[i] = 0;
      }
      if (closing[i] && closing[i] != id)
        closing[i] = 0;
      if (id && (client.failed.load() == id || !network.validSession(id) ||
                 now - client.last.load() > 15000)) {
        if (closing[i] != id &&
            httpd_queue_work(
                server, close_work,
                reinterpret_cast<void *>(static_cast<uintptr_t>(id))) == ESP_OK)
          closing[i] = id;
        outbox.removeClient(id);
        network.closeSession(id);
        engine.detach(id);
        attached[i] = 0;
      }
    }
    uart_event_t ev;
    while (xQueueReceive(uart_events, &ev, 0) == pdTRUE) {
      if (ev.type == UART_FIFO_OVF || ev.type == UART_BUFFER_FULL ||
          ev.type == UART_FRAME_ERR || ev.type == UART_PARITY_ERR) {
        uart_flush_input(UART_PORT);
        line.clear();
        dropping = false;
        engine.fault("Error UART; consulta de sincronizacion pendiente", now);
      }
    }
    uint8_t data[256];
    for (int pass = 0; pass < 4; ++pass) {
      const int count = uart_read_bytes(UART_PORT, data, sizeof(data), 0);
      if (count <= 0)
        break;
      for (int i = 0; i < count; ++i) {
        const char ch = static_cast<char>(data[i]);
        if (ch == '\r' || ch == '\n') {
          if (!line.empty() && !dropping)
            engine.line(line, now);
          line.clear();
          dropping = false;
        } else if (!dropping) {
          if (line.size() >= 1023) {
            line.clear();
            dropping = true;
            engine.fault("Linea RX demasiado larga; ver consola", now);
          } else
            line.push_back(ch);
        }
      }
    }
    Request r;
    for (int i = 0; i < 12 && xQueueReceive(requests, &r, 0) == pdTRUE; ++i) {
      Client *c = find_client(r.session);
      if (!c || !network.validSession(r.session) ||
          c->failed.load() == r.session)
        continue;
      if (r.op == Op::Attach) {
        if (!engine.attached(r.session)) {
          engine.attach(r.session);
          for (size_t j = 0; j < clients.size(); ++j)
            if (clients[j].id.load() == r.session)
              attached[j] = r.session;
        } else
          engine.status();
      } else if (!engine.attached(r.session))
        continue;
      else if (r.op == Op::Command)
        engine.accept(r.session, r.id, r.text[0], now);
      else if (r.op == Op::Batch) {
        std::vector<std::string> batch;
        for (size_t j = 0; j < r.count; ++j)
          batch.emplace_back(r.text[j]);
        engine.acceptBatch(r.session, r.id, batch, now);
      } else if (r.op == Op::Discard)
        engine.discard(r.session);
      else if (r.op == Op::Control)
        engine.machineControl(r.session, r.id, r.action, now);
    }
    engine.poll(now);
    if (now - last_status >= 1000) {
      last_status = now;
      engine.status();
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}
static void release_session(void *arg) {
  std::unique_ptr<Session> s(static_cast<Session *>(arg));
  if (!s)
    return;
  network.closeSession(s->id);
  auto &c = clients[s->slot];
  if (c.id.load() == s->id) {
    outbox.removeClient(s->id);
    c.id.store(0);
    c.fd.store(-1);
  }
}
static int websocket_send(httpd_handle_t, int fd, const char *data,
                          size_t length, int flags) {
  return bridge::sendNonblockingFramePart(fd, data, length, flags);
}
static bool peer_address(httpd_req_t *req, uint32_t &address) {
  const int fd = httpd_req_to_sockfd(req);
  if (fd < 0) {
    ESP_LOGW(TAG, "WS RECHAZADO: descriptor de socket invalido (%d)", fd);
    return false;
  }
  sockaddr_storage peer = {};
  socklen_t length = sizeof(peer);
  if (getpeername(fd, reinterpret_cast<sockaddr *>(&peer), &length) != 0) {
    ESP_LOGW(TAG, "WS RECHAZADO: getpeername(fd=%d) fallo; errno=%d", fd, errno);
    return false;
  }
  // ESP-IDF/lwIP puede presentar una conexion IPv4 como AF_INET6
  // con una direccion ::ffff:a.b.c.d. Extraemos IPv4 solo en ese caso.
  // No habilitamos conexiones IPv6 nativas ni anulamos la politica de red.
  if (peer.ss_family == AF_INET && length >= sizeof(sockaddr_in)) {
    const auto *v4 = reinterpret_cast<const sockaddr_in *>(&peer);
    address = ntohl(v4->sin_addr.s_addr);
  } else if (peer.ss_family == AF_INET6 && length >= sizeof(sockaddr_in6)) {
    const auto *v6 = reinterpret_cast<const sockaddr_in6 *>(&peer);
    const auto *b = reinterpret_cast<const uint8_t *>(&v6->sin6_addr);
    bool mapped = true;
    for (int i = 0; i < 10; ++i)
      if (b[i] != 0) { mapped = false; break; }
    if (!mapped || b[10] != 0xff || b[11] != 0xff) {
      ESP_LOGW(TAG, "WS RECHAZADO: IPv6 no es IPv4 mapeado");
      return false;
    }
    address = (static_cast<uint32_t>(b[12]) << 24) |
              (static_cast<uint32_t>(b[13]) << 16) |
              (static_cast<uint32_t>(b[14]) << 8) |
              static_cast<uint32_t>(b[15]);
    ESP_LOGI(TAG, "WS socket IPv4 mapeado a IPv6 reconocido");
  } else {
    ESP_LOGW(TAG, "WS RECHAZADO: familia de socket=%d, longitud=%u",
             static_cast<int>(peer.ss_family), static_cast<unsigned>(length));
    return false;
  }
  const bool allowed = address &&
                       (address & local_mask) == (local_address & local_mask) &&
                       address != local_address;
  ESP_LOGI(TAG, "WS origen=%u.%u.%u.%u, red=%08lx, mascara=%08lx, permitido=%d",
           static_cast<unsigned>((address >> 24) & 255),
           static_cast<unsigned>((address >> 16) & 255),
           static_cast<unsigned>((address >> 8) & 255),
           static_cast<unsigned>(address & 255),
           static_cast<unsigned long>(local_address),
           static_cast<unsigned long>(local_mask), allowed);
  return allowed;
}
static esp_err_t websocket_pre_handshake(httpd_req_t *req) {
  char host[128] = {}, origin[160] = {};
  httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host));
  if (httpd_req_get_hdr_value_len(req, "Origin") &&
      (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) !=
           ESP_OK ||
       std::string(origin) != std::string("http://") + host)) {
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN,
                        "Abrir la interfaz HTTP de esta ESP");
    return ESP_FAIL;
  }
  size_t index = clients.size();
  for (size_t i = 0; i < clients.size(); ++i)
    if (clients[i].id.load() == 0) {
      index = i;
      break;
    }
  if (index == clients.size()) {
    httpd_resp_set_status(req, "503 Service Unavailable");
    httpd_resp_sendstr(req, "Limite de sesiones alcanzado");
    return ESP_FAIL;
  }
  const uint32_t id = next_session.fetch_add(1);
  uint32_t address = 0;
  if (!peer_address(req, address)) {
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN,
                        "No se pudo validar la IP del cliente");
    return ESP_FAIL;
  }
  if (!network.openSession(address, id)) {
    ESP_LOGW(TAG, "WS RECHAZADO por politica: origen=%08lx, sesion=%lu, "
             "wifi=%d, sesiones de telefonos=%u",
             static_cast<unsigned long>(address),
             static_cast<unsigned long>(id),
             wifi_ready.load(),
             static_cast<unsigned>(network.state().phones));
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN,
                        "La politica de sesiones rechazo el acceso");
    return ESP_FAIL;
  }
  if (!outbox.addClient(id)) {
    network.closeSession(id);
    return ESP_FAIL;
  }
  auto &c = clients[index];
  c.fd.store(httpd_req_to_sockfd(req));
  c.last.store(now_ms());
  c.failed.store(0);
  c.dropped_console.store(0);
  c.id.store(id);
  req->sess_ctx = new Session{id, index};
  req->free_ctx = release_session;
  ESP_RETURN_ON_ERROR(httpd_sess_set_send_override(req->handle,
                                                   httpd_req_to_sockfd(req),
                                                   websocket_send),
                      TAG, "Nonblocking WebSocket");
  return ESP_OK;
}
static esp_err_t websocket_handler(httpd_req_t *req) {
  auto *ctx = static_cast<Session *>(req->sess_ctx);
  if (!ctx || !find_client(ctx->id) || !network.validSession(ctx->id))
    return ESP_FAIL;
  httpd_ws_frame_t frame = {};
  ESP_RETURN_ON_ERROR(httpd_ws_recv_frame(req, &frame, 0), TAG, "WS header");
  if (frame.type == HTTPD_WS_TYPE_CLOSE)
    return ESP_FAIL;
  if (frame.type != HTTPD_WS_TYPE_TEXT || !frame.len || frame.len > 1024 ||
      frame.fragmented)
    return ESP_FAIL;
  char payload[1025] = {};
  frame.payload = reinterpret_cast<uint8_t *>(payload);
  ESP_RETURN_ON_ERROR(httpd_ws_recv_frame(req, &frame, frame.len), TAG,
                      "WS payload");
  if (auto *c = find_client(ctx->id))
    c->last.store(now_ms());
  cJSON *o = cJSON_ParseWithLength(payload, frame.len);
  if (!o)
    return ESP_FAIL;
  Request r = {};
  r.session = ctx->id;
  const bool valid = bridge::parseRequest(o, r);
  cJSON_Delete(o);
  if (!valid)
    return ESP_FAIL;
  if (r.op == Op::Ping) {
    static char pong[] = "{\"type\":\"pong\"}";
    httpd_ws_frame_t response = {};
    response.type = HTTPD_WS_TYPE_TEXT;
    response.payload = reinterpret_cast<uint8_t *>(pong);
    response.len = sizeof(pong) - 1;
    return httpd_ws_send_frame(req, &response);
  }
  if (xQueueSend(requests, &r, 0) != pdTRUE)
    return ESP_FAIL;
  return ESP_OK;
}

static const char *content_type(const std::string &name) {
  auto ends = [&name](const char *ext) {
    const size_t n = std::strlen(ext);
    return name.size() >= n && name.compare(name.size() - n, n, ext) == 0;
  };
  if (ends(".html"))
    return "text/html; charset=utf-8";
  if (ends(".js"))
    return "application/javascript; charset=utf-8";
  if (ends(".css"))
    return "text/css; charset=utf-8";
  if (ends(".svg"))
    return "image/svg+xml";
  if (ends(".png"))
    return "image/png";
  if (ends(".woff2"))
    return "font/woff2";
  if (ends(".webmanifest"))
    return "application/manifest+json";
  if (ends(".txt"))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

static esp_err_t serve_file(httpd_req_t *req) {
  // Release static HTTP sockets after each response. Live WebSockets
  // must not be crowded out by idle browser asset connections.
  httpd_resp_set_hdr(req, "Connection", "close");
  std::string name(req->uri);
  name = name.substr(0, name.find('?'));
  if (name.size() > 118 || name.find("..") != std::string::npos ||
      name.find('%') != std::string::npos ||
      name.find('\\') != std::string::npos)
    return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Ruta invalida");
  if (name.back() == '/')
    name += "index.html";
  if (name == "/usb")
    name = "/usb/index.html";
  const std::string path = "/www" + name;
  FILE *file = std::fopen(path.c_str(), "rb");
  bool compressed = false;
  if (!file) {
    file = std::fopen((path + ".gz").c_str(), "rb");
    compressed = file != nullptr;
  }
  if (!file)
    return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND,
                               "Archivo no encontrado");
  httpd_resp_set_type(req, content_type(name));
  httpd_resp_set_hdr(req, "Cache-Control",
                     name.find("/_next/static/") == 0
                         ? "public, max-age=31536000, immutable"
                         : "no-cache");
  if (compressed)
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  // Stream bounded chunks; do not load the Next.js bundles into RAM.
  char chunk[3072];
  size_t count;
  esp_err_t result = ESP_OK;
  while ((count = std::fread(chunk, 1, sizeof(chunk), file)) > 0) {
    result = httpd_resp_send_chunk(req, chunk, count);
    if (result != ESP_OK)
      break;
  }
  std::fclose(file);
  if (result == ESP_OK)
    result = httpd_resp_send_chunk(req, nullptr, 0);
  return result;
}

static void file_task(void *) {
  httpd_req_t *request;
  for (;;) {
    if (xQueueReceive(file_requests, &request, portMAX_DELAY) != pdTRUE)
      continue;
    const esp_err_t result = serve_file(request);
    httpd_req_async_handler_complete(request);
    if (result != ESP_OK)
      ESP_LOGD(TAG, "File transfer finished with error: %d", result);
  }
}
static esp_err_t static_handler(httpd_req_t *req) {
  httpd_req_t *copy = nullptr;
  ESP_RETURN_ON_ERROR(httpd_req_async_handler_begin(req, &copy), TAG,
                      "Async file request");
  if (xQueueSend(file_requests, &copy, 0) != pdTRUE) {
    httpd_resp_set_status(copy, "503 Service Unavailable");
    httpd_resp_set_hdr(copy, "Retry-After", "1");
    httpd_resp_sendstr(copy, "Archivos ocupados; recargar en un momento");
    httpd_req_async_handler_complete(copy);
  }
  return ESP_OK;
}

static esp_err_t camera_info_handler(httpd_req_t *req) {
  const auto peer = camera_registry.snapshot(now_ms());
  const auto base = peer.baseUrl();
  cJSON *o = cJSON_CreateObject();
  if (!o) return ESP_ERR_NO_MEM;
  cJSON_AddBoolToObject(o, "available", peer.available);
  cJSON_AddStringToObject(o, "baseUrl", base.c_str());
  cJSON_AddStringToObject(o, "streamUrl", base.empty() ? "" : (base + "/stream").c_str());
  cJSON_AddStringToObject(o, "captureUrl", base.empty() ? "" : (base + "/capture").c_str());
  cJSON_AddStringToObject(o, "group", CONFIG_BRIDGE_PAIR_GROUP);
  cJSON_AddStringToObject(o, "build", "c3-direct-v4.1.3");
  cJSON_AddStringToObject(o, "cameraSource", "debian");
  cJSON_AddBoolToObject(o, "wifiConnected", wifi_ready.load());
  cJSON_AddNumberToObject(o, "wifiDisconnects", wifi_disconnects.load());
  cJSON_AddStringToObject(o, "c3Ip", CONFIG_BRIDGE_STATIC_IP);
  cJSON_AddNumberToObject(o, "phones", network.state().phones);
  cJSON_AddNumberToObject(o, "phoneLimit", bridge::PHONE_LIMIT);
  if (peer.available && peer.frame_age_ms != ARS_CAMERA_NO_FRAME)
    cJSON_AddNumberToObject(o, "frameAgeMs", peer.frame_age_ms + (now_ms() - peer.seen_at));
  else
    cJSON_AddNullToObject(o, "frameAgeMs");
  char *json = cJSON_PrintUnformatted(o);
  cJSON_Delete(o);
  if (!json) return ESP_ERR_NO_MEM;
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_set_hdr(req, "Connection", "close");
  const esp_err_t result = httpd_resp_sendstr(req, json);
  cJSON_free(json);
  return result;
}

static void camera_registry_task(void *) {
  int fd = -1;
  uint32_t socket_epoch = 0;
  for (;;) {
    if (!wifi_ready.load() || (fd >= 0 && socket_epoch != wifi_epoch.load())) {
      if (fd >= 0) { close(fd); fd = -1; }
      camera_registry.clear();
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if (fd < 0) {
      fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
      if (fd < 0) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
      int yes = 1;
      setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
      struct timeval timeout = {.tv_sec = 0, .tv_usec = 500000};
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
      sockaddr_in address = {};
      address.sin_family = AF_INET;
      address.sin_port = htons(ARS_CAMERA_UDP_PORT);
      address.sin_addr.s_addr = htonl(INADDR_ANY);
      if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0) {
        close(fd); fd = -1;
        vTaskDelay(pdMS_TO_TICKS(1000));
        continue;
      }
      socket_epoch = wifi_epoch.load();
    }
    char message[ARS_CAMERA_MESSAGE_MAX] = {};
    sockaddr_in source = {};
    socklen_t length = sizeof(source);
    const int got = recvfrom(fd, message, sizeof(message)-1, 0,
                             reinterpret_cast<sockaddr *>(&source), &length);
    if (got <= 0 || got == sizeof(message)-1 ||
        std::memchr(message, '\0', static_cast<size_t>(got)) ||
        !wifi_ready.load() || socket_epoch != wifi_epoch.load())
      continue;
    message[got] = '\0';
    const auto previous = camera_registry.snapshot(now_ms());
    if (camera_registry.update(message, CONFIG_BRIDGE_PAIR_GROUP,
                                ntohl(source.sin_addr.s_addr),
                                local_address, local_mask, now_ms())) {
      const auto current = camera_registry.snapshot(now_ms());
      if (!previous.available || previous.address != current.address ||
          previous.boot != current.boot)
        ESP_LOGI(TAG, "Camara descubierta: %s/stream", current.baseUrl().c_str());
    }
  }
}

static void wifi_event(void *, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_ready.store(false);
    wifi_epoch.fetch_add(1);
    wifi_disconnects.fetch_add(1);
    network.setOnline(false);
    camera_registry.clear();
    const auto *event = static_cast<wifi_event_sta_disconnected_t *>(data);
    ESP_LOGW(TAG, "WiFi perdido (razon %u). Reintentando sin detener UART.", event->reason);
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) ESP_LOGW(TAG, "Reintento WiFi: %s", esp_err_to_name(err));
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    wifi_epoch.fetch_add(1);
    wifi_ready.store(true);
    network.setOnline(true);
    ESP_LOGI(TAG, "Router conectado. Abrir http://%s/", CONFIG_BRIDGE_STATIC_IP);
  }
}

static void start_router_wifi() {
  esp_netif_t *sta = esp_netif_create_default_wifi_sta();
  ESP_ERROR_CHECK(sta ? ESP_OK : ESP_ERR_NO_MEM);
  const esp_err_t stop = esp_netif_dhcpc_stop(sta);
  if (stop != ESP_OK && stop != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED)
    ESP_ERROR_CHECK(stop);
  esp_netif_ip_info_t info = {};
  ip4_addr_t parsed = {};
  if (!ip4addr_aton(CONFIG_BRIDGE_STATIC_IP, &parsed)) abort();
  info.ip.addr = parsed.addr; local_address = ntohl(parsed.addr);
  if (!ip4addr_aton(CONFIG_BRIDGE_NETMASK, &parsed)) abort();
  info.netmask.addr = parsed.addr; local_mask = ntohl(parsed.addr);
  if (!ip4addr_aton(CONFIG_BRIDGE_GATEWAY, &parsed)) abort();
  info.gw.addr = parsed.addr;
  ESP_ERROR_CHECK(esp_netif_set_ip_info(sta, &info));
  ESP_ERROR_CHECK(esp_netif_set_hostname(sta, "impresora-ars"));
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, nullptr));
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  wifi_config_t config = {};
  const size_t ssid_length = std::strlen(CONFIG_BRIDGE_ROUTER_SSID);
  const size_t pass_length = std::strlen(CONFIG_BRIDGE_ROUTER_PASSWORD);
  if (!ssid_length || ssid_length > sizeof(config.sta.ssid) ||
      pass_length < 8 || pass_length > sizeof(config.sta.password)) {
    ESP_LOGE(TAG, "Configurar la clave del Technicolor con configurar_red.py antes de compilar");
    return;
  }
  std::memcpy(config.sta.ssid, CONFIG_BRIDGE_ROUTER_SSID, ssid_length);
  std::memcpy(config.sta.password, CONFIG_BRIDGE_ROUTER_PASSWORD, pass_length);
  config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
  config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
  ESP_ERROR_CHECK(esp_wifi_start());
  ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
}

extern "C" void app_main() {
  esp_err_t nvs = nvs_flash_init();
  if (nvs == ESP_ERR_NVS_NO_FREE_PAGES ||
      nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    nvs = nvs_flash_init();
  }
  ESP_ERROR_CHECK(nvs);
  requests = xQueueCreate(24, sizeof(Request));
  file_requests = xQueueCreate(16, sizeof(httpd_req_t *));
  boot_id = esp_random();
  assert(requests && file_requests);
  uart_config_t uart = {};
  uart.baud_rate = CONFIG_MARLIN_BAUD;
  uart.data_bits = UART_DATA_8_BITS;
  uart.parity = UART_PARITY_DISABLE;
  uart.stop_bits = UART_STOP_BITS_1;
  uart.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  uart.source_clk = UART_SCLK_DEFAULT;
  ESP_ERROR_CHECK(
      uart_driver_install(UART_PORT, 4096, 1024, 24, &uart_events, 0));
  ESP_ERROR_CHECK(uart_param_config(UART_PORT, &uart));
  ESP_ERROR_CHECK(uart_set_pin(UART_PORT, CONFIG_MARLIN_TX_GPIO,
                               CONFIG_MARLIN_RX_GPIO, UART_PIN_NO_CHANGE,
                               UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  start_router_wifi();
  esp_vfs_spiffs_conf_t fs = {};
  fs.base_path = "/www";
  fs.partition_label = "web";
  fs.max_files = 8;
  fs.format_if_mount_failed = false;
  ESP_ERROR_CHECK(esp_vfs_spiffs_register(&fs));
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.stack_size = 8192;
  // Keep three HTTP slots beside all control pages. ESP-IDF also reserves
  // three internal sockets, and the camera discovery uses one UDP socket.
  static_assert(CONFIG_LWIP_MAX_SOCKETS >= bridge::MAX_CLIENTS + 7,
                "Insufficient sockets for control, HTTP and camera discovery");
  config.max_open_sockets = bridge::MAX_CLIENTS + 3;
  config.lru_purge_enable = false;
  config.uri_match_fn = httpd_uri_match_wildcard;
  config.send_wait_timeout = 2;
  config.recv_wait_timeout = 2;
  ESP_ERROR_CHECK(httpd_start(&server, &config));
  httpd_uri_t ws = {};
  ws.uri = "/ws";
  ws.method = HTTP_GET;
  ws.handler = websocket_handler;
  ws.is_websocket = true;
  ws.handle_ws_control_frames = false;
  ws.ws_pre_handshake_cb = websocket_pre_handshake;
  ESP_ERROR_CHECK(httpd_register_uri_handler(server, &ws));
  httpd_uri_t camera_info = {};
  camera_info.uri = "/api/camera";
  camera_info.method = HTTP_GET;
  camera_info.handler = camera_info_handler;
  ESP_ERROR_CHECK(httpd_register_uri_handler(server, &camera_info));
  httpd_uri_t network_info = camera_info;
  network_info.uri = "/api/network";
  ESP_ERROR_CHECK(httpd_register_uri_handler(server, &network_info));
  httpd_uri_t files = {};
  files.uri = "/*";
  files.method = HTTP_GET;
  files.handler = static_handler;
  ESP_ERROR_CHECK(httpd_register_uri_handler(server, &files));
  assert(xTaskCreate(file_task, "web_files_1", 6144, nullptr, 3, nullptr) ==
         pdPASS);
  assert(xTaskCreate(file_task, "web_files_2", 6144, nullptr, 3, nullptr) ==
         pdPASS);
  assert(xTaskCreate(serial_task, "marlin_uart", 8192, nullptr, 8, nullptr) ==
         pdPASS);
  assert(xTaskCreate(network_task, "marlin_events", 4096, nullptr, 4,
                     nullptr) == pdPASS);
  assert(xTaskCreate(camera_registry_task, "camera_registry", 4096, nullptr, 3, nullptr) == pdPASS);
  ESP_LOGI(TAG, "Red externa %s; interfaz http://%s/", CONFIG_BRIDGE_ROUTER_SSID, CONFIG_BRIDGE_STATIC_IP);
  ESP_LOGI(TAG, "UART1 RX=%d TX=%d %d baud", CONFIG_MARLIN_RX_GPIO,
           CONFIG_MARLIN_TX_GPIO, CONFIG_MARLIN_BAUD);
}
