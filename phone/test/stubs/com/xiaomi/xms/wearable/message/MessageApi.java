package com.xiaomi.xms.wearable.message;
import com.xiaomi.xms.wearable.tasks.Task;
public class MessageApi {
    public int adds;
    public boolean failAdd;
    public OnMessageReceivedListener listener;
    public byte[] reply;
    public Task<Void> addListener(String id, OnMessageReceivedListener value) {
        adds++;
        if (!failAdd) listener = value;
        return new Task<>(null, failAdd);
    }
    public Task<Void> removeListener(String id) { listener = null; return new Task<>(null, false); }
    public Task<Void> sendMessage(String id, byte[] msg) { reply = msg; return new Task<>(null, false); }
}
