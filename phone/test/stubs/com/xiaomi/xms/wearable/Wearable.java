package com.xiaomi.xms.wearable;
import android.content.Context;
import com.xiaomi.xms.wearable.auth.AuthApi;
import com.xiaomi.xms.wearable.message.MessageApi;
import com.xiaomi.xms.wearable.node.NodeApi;
import com.xiaomi.xms.wearable.service.ServiceApi;
public class Wearable {
    public static final NodeApi nodes = new NodeApi();
    public static final AuthApi auth = new AuthApi();
    public static final MessageApi messages = new MessageApi();
    public static final ServiceApi service = new ServiceApi();
    public static NodeApi getNodeApi(Context c) { return nodes; }
    public static AuthApi getAuthApi(Context c) { return auth; }
    public static MessageApi getMessageApi(Context c) { return messages; }
    public static ServiceApi getServiceApi(Context c) { return service; }
}
