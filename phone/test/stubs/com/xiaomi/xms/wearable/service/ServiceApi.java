package com.xiaomi.xms.wearable.service;
public class ServiceApi {
    public OnServiceConnectionListener listener;
    public void registerServiceConnectionListener(OnServiceConnectionListener value) { listener = value; }
    public void unregisterServiceConnectionListener(OnServiceConnectionListener value) { if (listener == value) listener = null; }
    public void connect() { listener.onServiceConnected(); }
    public void disconnect() { listener.onServiceDisconnected(); }
}
