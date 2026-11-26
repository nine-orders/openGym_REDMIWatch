package android.os;
import java.util.ArrayList;
import java.util.List;
public class Handler {
    private static final List<Runnable> delayed = new ArrayList<>();
    public Handler(Looper looper) { }
    public boolean post(Runnable r) { r.run(); return true; }
    public boolean postDelayed(Runnable r, long delay) { delayed.add(r); return true; }
    public void removeCallbacks(Runnable r) { delayed.removeIf(x -> x == r); }
    public static void tick() { List<Runnable> copy = new ArrayList<>(delayed); delayed.clear(); copy.forEach(Runnable::run); }
    public static void reset() { delayed.clear(); }
}
