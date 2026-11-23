import { describe, expect, it } from "vitest";
import { createVoice, KokoroVoice } from "../src/voice";
import { checkScript } from "../src/outreach";
import { Db, loadConfig, seedDatabase, SandboxNotifier, type Ctx } from "../src/index";

// Kokoro voice provider: local Kokoro-82M behind an OpenAI-compatible speech endpoint. Renders audio only, never dials.

type Call = { url: string; init: RequestInit };
const stubFetch = (calls: Call[], status = 200, body = Buffer.from("ID3kokoro")) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? body : "nope", { status, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;

describe("Kokoro voice", () => {
  it("posts the script to the local speech endpoint with the male default voice and returns the audio", async () => {
    const calls: Call[] = [];
    const v = new KokoroVoice("http://127.0.0.1:8880/v1/", "am_michael", 1, stubFetch(calls));
    const s = await v.synthesize("Hello Maria, this is Elm Street Pharmacy. Please call us back at 5 5 5, 0 1 0, 2 2 0 0.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: "kokoro", voice: "am_michael", response_format: "mp3" });
    expect(body.input).toContain("Elm Street Pharmacy");
    expect(s).toMatchObject({ mime: "audio/mpeg", voice: "kokoro:am_michael" });
    expect(s!.bytes.toString()).toBe("ID3kokoro");
  });

  it("refuses any non-loopback URL, so voicemail text never leaves the machine", () => {
    for (const u of ["https://tts.example.com", "http://10.0.0.5:8880", "http://127.0.0.1.example.com", "ftp://127.0.0.1", "not a url"]) {
      expect(() => new KokoroVoice(u, "am_michael"), u).toThrow(/KOKORO_URL/);
    }
    for (const u of ["http://localhost:8880", "http://[::1]:8880", "http://127.0.0.1:8880"]) expect(() => new KokoroVoice(u, "am_adam"), u).not.toThrow();
  });

  it("throws on a server error so the caller falls back to the device voice", async () => {
    const v = new KokoroVoice("http://127.0.0.1:8880", "am_adam", 1, stubFetch([], 500));
    await expect(v.synthesize("Hello")).rejects.toThrow("kokoro 500");
  });

  it("is chosen by VOICE_PROVIDER=kokoro with KOKORO_VOICE, and by auto when KOKORO_URL is set", async () => {
    const a = await createVoice({ VOICE_PROVIDER: "kokoro", KOKORO_VOICE: "am_adam" });
    expect([a.name, a.voice]).toEqual(["kokoro", "am_adam"]);
    const b = await createVoice({ KOKORO_URL: "http://127.0.0.1:8880" });
    expect([b.name, b.voice]).toEqual(["kokoro", "am_michael"]);
    await expect(createVoice({ VOICE_PROVIDER: "kokoro", KOKORO_URL: "https://tts.example.com" })).rejects.toThrow(/KOKORO_URL/);
  });

  it("voicemail rules still apply before any provider speaks: no medicine, recall reason or patient id", () => {
    const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 0, nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
    const db = new Db(":memory:");
    seedDatabase(db, cfg);
    const ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => Date.now() } as Ctx;
    const ok = "Hello {first_name}, this is {pharmacy_name}. Please call us back about a medicine you picked up on {sold_date}. Our number is {pharmacy_phone}.";
    expect(checkScript(ctx, ok)).toEqual([]);
    expect(checkScript(ctx, ok + " It is about {drug_name}.").join(" ")).toMatch(/must not name the medicine/);
    expect(checkScript(ctx, ok + " This is a recall.").join(" ")).toMatch(/recall reason/);
    expect(checkScript(ctx, ok + " Patient S-0417.").join(" ")).toMatch(/patient ID/);
  });
});
