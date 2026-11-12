idf_component_register(SRCS "main.cpp" INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_netif esp_event esp_http_server nvs_flash
             esp_driver_uart esp_timer spiffs cjson pthread)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra)
