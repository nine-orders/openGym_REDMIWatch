package com.xiaomi.xms.wearable.node;
import com.xiaomi.xms.wearable.tasks.Task;
import java.util.Collections;
import java.util.List;
public class NodeApi {
    public List<Node> nodes = Collections.emptyList();
    public boolean installed = true, installedFailure;
    public Task<List<Node>> getConnectedNodes() { return new Task<>(nodes, false); }
    public Task<Boolean> isWearAppInstalled(String id) { return new Task<>(installed, installedFailure); }
}
