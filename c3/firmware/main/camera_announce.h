#ifndef ARS_CAMERA_ANNOUNCE_H
#define ARS_CAMERA_ANNOUNCE_H
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#define ARS_CAMERA_UDP_PORT 40123
#define ARS_CAMERA_TTL_MS 8000u
#define ARS_CAMERA_NO_FRAME UINT32_MAX
#define ARS_CAMERA_MESSAGE_MAX 128

typedef struct {
    uint16_t port;
    uint32_t boot;
    uint32_t sequence;
    uint32_t frame_age_ms;
} ars_camera_announcement;

static inline int ars_camera_u32(const char **cursor, uint32_t *out, char separator) {
    const char *p = *cursor;
    if (*p < '0' || *p > '9') return 0;
    uint64_t n = 0;
    while (*p >= '0' && *p <= '9') {
        n = n * 10u + (unsigned)(*p++ - '0');
        if (n > UINT32_MAX) return 0;
    }
    if (*p != separator) return 0;
    *out = (uint32_t)n;
    *cursor = separator ? p + 1 : p;
    return 1;
}

static inline int ars_camera_parse(const char *message, const char *group,
                                    ars_camera_announcement *out) {
    const char prefix[] = "ARS_CAM1|";
    if (!message || !group || !out || strncmp(message, prefix, sizeof(prefix)-1)) return 0;
    const char *p = message + sizeof(prefix)-1;
    const size_t group_len = strlen(group);
    if (!group_len || group_len > 31 || strncmp(p, group, group_len) || p[group_len] != '|') return 0;
    p += group_len + 1;
    uint32_t port = 0;
    if (!ars_camera_u32(&p, &port, '|') || port == 0 || port > 65535u ||
        !ars_camera_u32(&p, &out->boot, '|') ||
        !ars_camera_u32(&p, &out->sequence, '|') ||
        !ars_camera_u32(&p, &out->frame_age_ms, '\0')) return 0;
    out->port = (uint16_t)port;
    return 1;
}

static inline int ars_camera_format(char *dest, size_t size, const char *group,
                                     uint16_t port, uint32_t boot,
                                     uint32_t sequence, uint32_t age) {
    int n = snprintf(dest, size, "ARS_CAM1|%s|%u|%" PRIu32 "|%" PRIu32 "|%" PRIu32,
                     group, (unsigned)port, boot, sequence, age);
    return n > 0 && (size_t)n < size ? n : 0;
}
#endif

