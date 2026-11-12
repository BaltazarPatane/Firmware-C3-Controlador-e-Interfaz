#pragma once
#include "bridge_core.hpp"
#include "cJSON.h"
#include "network_policy.hpp"
#include <cmath>

namespace bridge {
inline cJSON *makeMessage(const Core &core, const Event &event, uint32_t client,
                          uint32_t boot, NetworkState network = {}) {
  cJSON *json = cJSON_CreateObject();
  if (!json)
    return nullptr;
  cJSON_AddStringToObject(json, "type", event.type.c_str());
  if (event.id)
    cJSON_AddNumberToObject(json, "id", event.id);
  if (event.origin)
    cJSON_AddNumberToObject(json, "origin", event.origin);
  if (!event.text.empty())
    cJSON_AddStringToObject(json, "text", event.text.c_str());
  if (event.line >= 0)
    cJSON_AddNumberToObject(json, "line", event.line);
  if (event.type == "status") {
    cJSON_AddNumberToObject(json, "protocol", 3);
    cJSON_AddStringToObject(json, "version", "4.1.3-direct");
    cJSON_AddBoolToObject(json, "machineControls", true);
    cJSON_AddBoolToObject(json, "fileJobs", false);
    cJSON_AddNumberToObject(json, "phones", network.phones);
    cJSON_AddNumberToObject(json, "phoneLimit", PHONE_LIMIT);
    cJSON_AddBoolToObject(json, "cameraReserved", true);
    cJSON_AddBoolToObject(json, "cameraAssociated", network.camera);
    // The caller fills this from the live Debian registry, never a fixed DHCP IP.
    cJSON_AddStringToObject(json, "cameraUrl", "");
    cJSON_AddNumberToObject(json, "clientId", client);
    cJSON_AddNumberToObject(json, "bootId", boot);
    cJSON_AddNumberToObject(json, "generation", core.generation());
    cJSON_AddBoolToObject(json, "ready", core.ready());
    cJSON_AddStringToObject(json, "stage", core.stage());
    cJSON_AddBoolToObject(json, "emergency", core.emergency());
    cJSON_AddBoolToObject(json, "paused", core.paused());
    cJSON_AddStringToObject(json, "pausePhase", core.pausePhase());
    cJSON_AddNumberToObject(json, "pending", core.pending());
    cJSON_AddNumberToObject(json, "movements", core.pendingMovements());
    cJSON_AddNumberToObject(json, "clients", core.clients());
    cJSON_AddStringToObject(json, "reason", core.reason().c_str());
    cJSON_AddStringToObject(json, "position", core.position().c_str());
    cJSON_AddBoolToObject(json, "sdPrinting", core.sdPrinting());
    cJSON_AddBoolToObject(json, "sdPaused", core.sdPaused());
    cJSON_AddNumberToObject(json, "sdDone", core.sdDone());
    cJSON_AddNumberToObject(json, "sdTotal", core.sdTotal());
  } else if (event.type == "job") {
    const auto &job = core.job();
    cJSON_AddNumberToObject(json, "owner", job.owner);
    cJSON *snapshot = cJSON_AddObjectToObject(json, "job");
    cJSON_AddStringToObject(snapshot, "fileName", job.name.c_str());
    cJSON_AddNumberToObject(snapshot, "fileSize", job.size);
    cJSON_AddStringToObject(snapshot, "state", job.state.c_str());
    cJSON_AddNumberToObject(snapshot, "totalCommands", job.total);
    cJSON_AddNumberToObject(snapshot, "acknowledgedCommands", job.acknowledged);
    cJSON_AddNumberToObject(
        snapshot, "progress",
        job.total ? std::round(100.0 * job.acknowledged / job.total) : 0);
    if (!job.error.empty())
      cJSON_AddStringToObject(snapshot, "error", job.error.c_str());
  }
  return json;
}
} // namespace bridge
