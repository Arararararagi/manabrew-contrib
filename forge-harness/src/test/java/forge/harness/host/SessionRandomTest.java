package forge.harness.host;

import java.util.Arrays;

public final class SessionRandomTest {
    public static void main(final String[] args) {
        final String seed = "ab".repeat(32);
        final byte[] first = sequence(seed, "seat:0:shuffle:0");
        if (!Arrays.equals(first, sequence(seed, "seat:0:shuffle:0"))) {
            throw new AssertionError("same stream must replay");
        }
        for (final String domain : new String[]{"seat:1:shuffle:0", "seat:0:shuffle:1", "shared:game"}) {
            if (Arrays.equals(first, sequence(seed, domain))) {
                throw new AssertionError("stream domains must be separate");
            }
        }
        if (Arrays.equals(first, sequence("ac" + seed.substring(2), "seat:0:shuffle:0"))
                || Arrays.equals(first, sequence(seed.substring(0, 62) + "ac", "seat:0:shuffle:0"))) {
            throw new AssertionError("the full seed must affect the stream");
        }
        final SessionRandom rng = new SessionRandom(seed, "bounded");
        for (int bound = 1; bound < 200; bound++) {
            final int value = rng.nextInt(bound);
            if (value < 0 || value >= bound) throw new AssertionError("invalid bounded sample");
        }
        System.out.println("SessionRandomTest passed");
    }

    private static byte[] sequence(final String seed, final String domain) {
        final byte[] bytes = new byte[128];
        new SessionRandom(seed, domain).nextBytes(bytes);
        return bytes;
    }
}
