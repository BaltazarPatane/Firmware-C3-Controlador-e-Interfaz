#pragma once
#include "bridge_core.hpp"
#include "cJSON.h"
#include <cmath>
#include <cstring>

namespace bridge {
enum class Op { Attach, Ping, Command, Batch, Discard, Control };
struct Request {
  Op op{};
  uint32_t session = 0, id = 0;
  uint8_t count = 0;
  char text[8][MAX_TEXT + 1]{};
  char action[8]{};
};
inline bool parseRequest(cJSON *o, Request &r) {
  if (!cJSON_IsObject(o))
    return false;
  const auto str = [o](const char *key) -> const char * {
    const auto *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsString(v) ? v->valuestring : "";
  };
  const std::string type = str("type");
  if (type == "hello") {
    r.op = Op::Attach;
    const auto *v = cJSON_GetObjectItemCaseSensitive(o, "protocol");
    return cJSON_IsNumber(v) && v->valuedouble == 3;
  }
  if (type == "ping") {
    r.op = Op::Ping;
    return true;
  }
  if (type == "discard") {
    r.op = Op::Discard;
    return true;
  }
  if (type != "command" && type != "batch" && type != "control")
    return false;
  const auto *v = cJSON_GetObjectItemCaseSensitive(o, "id");
  if (!cJSON_IsNumber(v) || !std::isfinite(v->valuedouble) ||
      v->valuedouble < 1 || v->valuedouble > UINT32_MAX ||
      std::floor(v->valuedouble) != v->valuedouble)
    return false;
  r.id = static_cast<uint32_t>(v->valuedouble);
  const auto *job = cJSON_GetObjectItemCaseSensitive(o, "job");
  if (job && !cJSON_IsFalse(job))
    return false;
  if (type == "control") {
    r.op = Op::Control;
    const std::string action = str("action");
    if (action != "pause" && action != "resume")
      return false;
    std::strcpy(r.action, action.c_str());
    return true;
  }
  r.op = type == "command" ? Op::Command : Op::Batch;
  const auto *texts = cJSON_GetObjectItemCaseSensitive(o, "texts");
  const int count = r.op == Op::Command ? 1 : cJSON_GetArraySize(texts);
  if (count < 1 || count > 8 ||
      r.id > UINT32_MAX - static_cast<uint32_t>(count - 1) ||
      (r.op == Op::Batch && !cJSON_IsArray(texts)))
    return false;
  r.count = count;
  for (int i = 0; i < count; ++i) {
    const auto *t = r.op == Op::Command
                        ? cJSON_GetObjectItemCaseSensitive(o, "text")
                        : cJSON_GetArrayItem(texts, i);
    if (!cJSON_IsString(t) || !std::strlen(t->valuestring) ||
        std::strlen(t->valuestring) > MAX_TEXT)
      return false;
    std::strcpy(r.text[i], t->valuestring);
  }
  return true;
}
} // namespace bridge
