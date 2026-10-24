package forge.harness.host;

import com.google.gson.*;
import forge.game.card.Card;
import forge.game.zone.ZoneType;
import forge.model.FModel;
import java.lang.management.ManagementFactory;
import java.util.*;

public final class VerificationBenchmark {
    public static void main(String[] args) throws Exception {
        Thread.currentThread().setName("Game-verification-benchmark");
        final ManaBrewEngineAdapter adapter = new ManaBrewEngineAdapter();
        adapter.initialize(args.length > 0 ? args[0] : "forge/forge-gui/");
        final JsonObject request = new JsonObject();
        request.addProperty("gameId", "verification-benchmark");
        request.addProperty("variant", "Commander");
        request.addProperty("startingLife", 40);
        request.addProperty("seed", 43);
        request.addProperty("snapshotRecording", false);
        request.addProperty("decisionJournal", true);
        request.addProperty("journalRewind", true);
        final JsonArray players = new JsonArray();
        for (int seat = 0; seat < 4; seat++) {
            final JsonObject player = new JsonObject();
            player.addProperty("name", "Player " + seat);
            player.addProperty("ai", false);
            player.add("commanderNames", JsonParser.parseString("[\"Isamaru, Hound of Konda\"]"));
            final JsonArray deck = new JsonArray();
            for (int i = 0; i < 100; i++) {
                final JsonObject card = new JsonObject();
                card.addProperty("name", i == 0 ? "Isamaru, Hound of Konda" : "Plains");
                deck.add(card);
            }
            player.add("deck", deck);
            players.add(player);
        }
        request.add("players", players);
        adapter.startGameJson(request.toString());
        final long deadline = System.nanoTime() + 30_000_000_000L;
        while (adapter.getPrompt("verification-benchmark", 0).isEmpty()) {
            if (System.nanoTime() > deadline) throw new AssertionError("no prompt");
            Thread.sleep(5);
        }
        final var field = ManaBrewEngineAdapter.class.getDeclaredField("sessions");
        field.setAccessible(true);
        final ManaBrewInteractiveSession session = (ManaBrewInteractiveSession) ((Map<?, ?>) field.get(adapter)).get("verification-benchmark");
        final ReplayRandom rng = new ReplayRandom(43);
        final com.sun.management.ThreadMXBean allocations = (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
        allocations.setThreadAllocatedMemoryEnabled(true);
        final long thread = Thread.currentThread().getId();
        System.out.println("BENCH JVM=" + System.getProperty("java.version") + " arch=" + System.getProperty("os.arch") + " warmup=20 samples=100 seats=4 deck=100 each");
        for (int total : new int[] {0, 40, 160, 320}) {
            for (final var player : session.getGame().getRegisteredPlayers()) {
                while (player.getCardsIn(ZoneType.Battlefield).size() < total / 4) {
                    final Card card = Card.fromPaperCard(FModel.getMagicDb().getCommonCards().getCard("Memnite"), player);
                    player.getZone(ZoneType.Battlefield).add(card);
                }
            }
            final JsonObject before = LegacyVerification.verification(session, rng);
            if (!before.equals(GameCheckpoint.verification(session, rng))) throw new AssertionError("witness changed at board size " + total);
            for (int i = 0; i < 20; i++) {
                LegacyVerification.verification(session, rng);
                GameCheckpoint.verification(session, rng);
            }
            final long[][] times = new long[2][100], bytes = new long[2][100];
            for (int i = 0; i < 100; i++) {
                for (int order = 0; order < 2; order++) {
                    final int variant = (i + order) % 2;
                    final long allocated = allocations.getThreadAllocatedBytes(thread), start = System.nanoTime();
                    final JsonObject witness = variant == 0 ? LegacyVerification.verification(session, rng) : GameCheckpoint.verification(session, rng);
                    times[variant][i] = System.nanoTime() - start;
                    bytes[variant][i] = allocations.getThreadAllocatedBytes(thread) - allocated;
                    if (!before.equals(witness)) throw new AssertionError("unstable witness");
                }
            }
            for (int variant = 0; variant < 2; variant++) {
                Arrays.sort(times[variant]); Arrays.sort(bytes[variant]);
                System.out.printf(Locale.ROOT, "BENCH board=%d %s median_ms=%.3f p95_ms=%.3f allocated_bytes=%d%n", total,
                    variant == 0 ? "baseline" : "optimized", times[variant][49] / 1e6, times[variant][94] / 1e6, bytes[variant][49]);
            }
        }
        adapter.endGame("verification-benchmark");
        System.exit(0);
    }
}
