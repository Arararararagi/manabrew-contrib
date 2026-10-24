package forge.harness.host;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.TreeMap;

final class LegacyVerification {
    private static final Gson GSON = new Gson();
    static JsonObject verification(final ManaBrewInteractiveSession session, final ReplayRandom rng) {
        final JsonObject state = new JsonObject();
        final JsonArray views = new JsonArray();
        for (int seat = -1; seat < session.getGame().getRegisteredPlayers().size(); seat++) {
            final JsonObject view = JsonParser.parseString(session.snapshotJson(seat)).getAsJsonObject();
            view.remove("checkpoints");
            view.remove("restoreVote");
            view.remove("snapshotRecording");
            view.remove("decisionHistory");
            views.add(view);
        }
        state.add("views", views);
        final JsonArray zones = new JsonArray();
        for (final Player player : session.getGame().getRegisteredPlayers()) {
            for (final ZoneType zone : ZoneType.values()) {
                final JsonArray cards = new JsonArray();
                for (final Card card : player.getCardsIn(zone)) {
                    final JsonObject identity = new JsonObject();
                    identity.addProperty("id", card.getId());
                    identity.addProperty("name", card.getName());
                    identity.addProperty("foil", card.getPaperCard() != null && card.getPaperCard().isFoil());
                    identity.addProperty("state", card.getCurrentStateName().name());
                    identity.addProperty("paper", card.getPaperCard() == null ? "" :
                            card.getPaperCard().getName() + "|" + card.getPaperCard().getEdition()
                                    + "|" + card.getPaperCard().getCollectorNumber());
                    cards.add(identity);
                }
                zones.add(cards);
            }
        }
        state.add("zones", zones);
        final JsonObject verification = new JsonObject();
        verification.addProperty("state", digest(canonical(state).toString().getBytes(StandardCharsets.UTF_8)));
        verification.addProperty("rng", rng.position());
        return verification;
    }

    private static String digest(final byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static JsonElement canonical(final JsonElement value) {
        if (value.isJsonObject()) {
            final TreeMap<String, JsonElement> sorted = new TreeMap<>();
            value.getAsJsonObject().entrySet().forEach(entry -> sorted.put(entry.getKey(), canonical(entry.getValue())));
            return GSON.toJsonTree(sorted);
        }
        if (value.isJsonArray()) {
            final JsonArray array = new JsonArray();
            value.getAsJsonArray().forEach(entry -> array.add(canonical(entry)));
            return array;
        }
        return value;
    }
}
