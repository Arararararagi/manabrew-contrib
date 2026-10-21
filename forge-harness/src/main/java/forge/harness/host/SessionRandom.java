package forge.harness.host;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Random;

final class SessionRandom extends Random {
    private final byte[] key;
    private final MessageDigest digest;
    private long counter;
    private byte[] block = new byte[0];
    private int offset;

    SessionRandom(final String seed, final String domain) {
        super(0);
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
        digest.update(HexFormat.of().parseHex(seed));
        key = digest.digest(("forge/session-random/v1:" + domain).getBytes(StandardCharsets.UTF_8));
    }

    @Override
    protected synchronized int next(final int bits) {
        if (offset == block.length) {
            digest.update(key);
            block = digest.digest(ByteBuffer.allocate(Long.BYTES).putLong(counter++).array());
            offset = 0;
        }
        final int value = ByteBuffer.wrap(block, offset, Integer.BYTES).getInt();
        offset += Integer.BYTES;
        return value >>> (32 - bits);
    }
}
