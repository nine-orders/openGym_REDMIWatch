package com.xiaomi.xms.wearable.auth;
public final class Permission {
    public static final Permission DEVICE_MANAGER = new Permission("data_manager");
    public static final Permission NOTIFY = new Permission("notify");

    private final String name;

    Permission(String name) { this.name = name; }

    public String getName() { return name; }
}
