package com.xiaomi.xms.wearable.tasks;
import java.util.function.Consumer;
public class Task<T> {
    private final T value;
    private final Exception error;
    public Task(T value, boolean fail) { this.value = value; this.error = fail ? new Exception("simulated failure") : null; }
    public Task<T> addOnSuccessListener(Consumer<T> fn) { if (error == null) fn.accept(value); return this; }
    public Task<T> addOnFailureListener(Consumer<Exception> fn) { if (error != null) fn.accept(error); return this; }
}
