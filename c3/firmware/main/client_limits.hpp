#pragma once
#include <cstddef>

namespace bridge {
// The router connects devices. These limits apply to active control pages;
// the Debian camera sends video directly and never takes a control slot.
inline constexpr size_t PHONE_LIMIT = 5, TABS_PER_PHONE = 2;
inline constexpr size_t MAX_CLIENTS = PHONE_LIMIT * TABS_PER_PHONE;
} // namespace bridge
