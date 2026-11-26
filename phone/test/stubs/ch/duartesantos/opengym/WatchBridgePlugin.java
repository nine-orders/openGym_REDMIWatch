package ch.duartesantos.opengym;
public class WatchBridgePlugin {
    public static int linkChanges, eventNotifications;
    static void notifyNewEvents() { eventNotifications++; }
    static void notifyWatchState() { linkChanges++; }
}
