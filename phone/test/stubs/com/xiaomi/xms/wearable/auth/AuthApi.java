package com.xiaomi.xms.wearable.auth;
import com.xiaomi.xms.wearable.tasks.Task;
public class AuthApi {
    public boolean fail;
    public boolean notifyOnly;

    public Task<Permission[]> requestPermission(String id, Permission... permissions) {
        Permission[] granted = notifyOnly ? new Permission[] { Permission.NOTIFY } : permissions;
        Permission[] fromParcel = new Permission[granted.length];
        for (int i = 0; i < granted.length; i++) fromParcel[i] = new Permission(granted[i].getName());
        return new Task<>(fromParcel, fail);
    }
}
