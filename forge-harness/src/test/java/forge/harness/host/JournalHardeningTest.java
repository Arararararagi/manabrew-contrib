package forge.harness.host;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public final class JournalHardeningTest {
    private static final String START = "{\"decisionJournal\":true}";
    private static final String PROMPT = "{\"decidingPlayerId\":\"player-2\",\"promptId\":1}";
    private static final JsonObject ACTION = JsonParser.parseString("{\"type\":\"chooseAction\",\"output\":{\"type\":\"pass\"}}").getAsJsonObject();
    private static final JsonObject VERIFICATION = JsonParser.parseString("{\"state\":\"digest\",\"rng\":\"position\"}").getAsJsonObject();

    public static void main(String[] args) throws Exception {
        final DecisionHistory bytes = new DecisionHistory(START, null);
        bytes.record(2, PROMPT, ACTION, VERIFICATION);
        final var field = DecisionHistory.class.getDeclaredField("bytes");
        field.setAccessible(true);
        field.setInt(bytes, 64 * 1024 * 1024 - 1);
        bytes.record(2, PROMPT, ACTION, VERIFICATION);
        check(bytes.size() == 1 && bytes.unavailableReason() != null, "byte limit stops recording");
        check(JsonParser.parseString(bytes.rewind(1)).getAsJsonObject().get("nextSequence").getAsInt() == 1, "byte limit preserves prefix");

        final DecisionHistory count = new DecisionHistory(START, null);
        for (int i = 0; i < 50001; i++) count.record(2, PROMPT, ACTION, VERIFICATION);
        check(count.size() == 50000 && count.unavailableReason() != null, "entry limit stops recording");
        final JsonObject snapshot = JsonParser.parseString(count.rewind(2)).getAsJsonObject();
        final DecisionHistory replay = new DecisionHistory(START, snapshot);
        check(replay.replayAction(PROMPT, VERIFICATION).equals(ACTION), "valid multiplayer replay");
        check(replay.replayAction(PROMPT, VERIFICATION) == null, "terminal boundary verified");
        final JsonObject entry = snapshot.getAsJsonObject("journal").getAsJsonArray("entries").get(0).getAsJsonObject();
        entry.addProperty("playerIndex", 1);
        expectFailure(() -> new DecisionHistory(START, snapshot), "player mismatch");
        entry.addProperty("playerIndex", 2);
        final DecisionHistory wrongPrompt = new DecisionHistory(START, snapshot);
        expectFailure(() -> wrongPrompt.replayAction(PROMPT.replace("player-2", "player-1"), VERIFICATION), "prompt divergence");
        final DecisionHistory wrongRng = new DecisionHistory(START, snapshot);
        expectFailure(() -> wrongRng.replayAction(PROMPT, new JsonObject()), "state/RNG divergence");
        final String request = "{\"gameId\":\"test\",\"decisionJournal\":true,\"journalRewind\":true,\"decisionJournalCommitBarrier\":true,\"players\":[{\"name\":\"a\",\"deck\":[{\"name\":\"Forest\"}]},{\"name\":\"b\",\"deck\":[{\"name\":\"Forest\"}]}]}";
        expectFailure(() -> new ManaBrewEngineAdapter().startGameJson(request), "external commit barrier");
        System.out.println("PASS: retained limits, player identity, prompt/RNG divergence, incompatible delivery modes");
    }

    private static void expectFailure(Runnable action, String message) {
        try { action.run(); } catch (RuntimeException error) {
            check(error.getMessage().contains(message), "unexpected error: " + error);
            return;
        }
        throw new AssertionError("accepted " + message);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
