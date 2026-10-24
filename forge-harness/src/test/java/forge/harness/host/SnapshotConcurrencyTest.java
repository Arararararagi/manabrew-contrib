package forge.harness.host;

import com.google.gson.*;
import java.util.concurrent.atomic.*;

public final class SnapshotConcurrencyTest {
    public static void main(String[] args) throws Exception {
        final ManaBrewEngineAdapter adapter = new ManaBrewEngineAdapter();
        adapter.initialize("forge/forge-gui/");
        final JsonObject start = JsonParser.parseString("{\"gameId\":\"snapshot-race\",\"variant\":\"Constructed\",\"seed\":43,\"snapshotRecording\":false,\"decisionJournal\":true,\"journalRewind\":true}").getAsJsonObject();
        final JsonArray players = new JsonArray();
        for (int seat = 0; seat < 3; seat++) {
            final JsonObject player = new JsonObject();
            player.addProperty("name", "Player " + seat);
            final JsonArray deck = new JsonArray();
            for (int i = 0; i < 60; i++) deck.add(JsonParser.parseString("{\"name\":\"Forest\"}"));
            player.add("deck", deck);
            players.add(player);
        }
        start.add("players", players);
        adapter.startGameJson(start.toString());
        final AtomicBoolean stop = new AtomicBoolean();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final AtomicInteger reads = new AtomicInteger();
        final Thread[] readers = new Thread[3];
        for (int i = 0; i < readers.length; i++) {
            final int viewer = i - 1;
            readers[i] = new Thread(() -> {
                try {
                    while (!stop.get()) {
                        final JsonObject view = JsonParser.parseString(adapter.getSnapshot("snapshot-race", viewer)).getAsJsonObject();
                        if (!"snapshot-race".equals(view.get("gameId").getAsString())) throw new AssertionError("wrong game");
                        reads.incrementAndGet();
                        Thread.sleep(1);
                    }
                } catch (Throwable error) { failure.compareAndSet(null, error); }
            });
            readers[i].start();
        }
        try {
            int previous = -1;
            for (int decision = 0; decision < 100; decision++) {
                final long deadline = System.nanoTime() + 10_000_000_000L;
                JsonObject prompt;
                while (true) {
                    if (failure.get() != null) throw new AssertionError("snapshot raced with engine advancement", failure.get());
                    final String raw = adapter.getPrompt("snapshot-race", 0);
                    prompt = raw.isEmpty() ? null : JsonParser.parseString(raw).getAsJsonObject();
                    if (prompt != null && prompt.get("promptId").getAsInt() != previous) break;
                    if (System.nanoTime() > deadline) throw new AssertionError("prompt timeout: " + adapter.getEngineError("snapshot-race"));
                    Thread.sleep(1);
                }
                previous = prompt.get("promptId").getAsInt();
                if (decision == 10) adapter.submitAction("snapshot-race", "{\"type\":\"directive\",\"player\":1,\"directive\":{\"type\":\"concede\"}}");
                final String type = prompt.getAsJsonObject("input").get("type").getAsString();
                final String output = switch (type) {
                    case "diceRolled" -> "{\"type\":\"diceRolledAcknowledged\"}";
                    case "mulligan" -> "{\"type\":\"mulliganDecision\",\"keep\":true}";
                    case "chooseAction" -> "{\"type\":\"pass\"}";
                    case "chooseAttackers", "chooseBlockers" -> "{\"assignments\":[]}";
                    case "chooseCards" -> {
                        final JsonObject input = prompt.getAsJsonObject("input");
                        final JsonArray chosen = new JsonArray();
                        for (int card = 0; card < input.get("min").getAsInt(); card++) {
                            chosen.add(input.getAsJsonArray("cards").get(card).getAsJsonObject().get("id"));
                        }
                        final JsonObject selection = new JsonObject();
                        selection.addProperty("type", "chooseCardsDecision");
                        selection.add("chosenCardIds", chosen);
                        yield selection.toString();
                    }
                    default -> throw new AssertionError("unexpected prompt " + type);
                };
                adapter.submitAction("snapshot-race", "{\"type\":\"" + type + "\",\"output\":" + output + "}");
                Thread.sleep(2);
            }
        } finally {
            stop.set(true);
            for (Thread reader : readers) reader.join(10000);
            adapter.endGame("snapshot-race");
        }
        if (failure.get() != null) throw new AssertionError("snapshot race", failure.get());
        if (reads.get() < 100) throw new AssertionError("insufficient concurrent reads: " + reads);
        System.out.println("PASS: " + reads + " concurrent snapshots through startup, decisions and concession");
    }
}
