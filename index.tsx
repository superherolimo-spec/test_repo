import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Maximize2, Minimize2, Share2, Moon } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getMasjidData } from "@/lib/masjid.functions";
import {
  buildPrayers,
  computeStatus,
  formatCountdown,
  formatTime,
  hijriDate,
  upcomingIqamah,
} from "@/lib/prayer-times";
import { ProgressRing } from "@/components/masjid/ProgressRing";
import { RemindersCard } from "@/components/masjid/RemindersCard";
import { AdminDialog } from "@/components/masjid/AdminDialog";
import { ThemePicker } from "@/components/masjid/ThemePicker";
import { SilentBanner } from "@/components/masjid/SilentBanner";
import { TasbihWidget } from "@/components/masjid/TasbihWidget";
import {
  applyTheme,
  isThemeId,
  PATTERN_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "@/lib/themes";
import { Button } from "@/components/ui/button";

const masjidQuery = queryOptions({
  queryKey: ["masjid"],
  queryFn: () => getMasjidData(),
});

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(masjidQuery),
  head: () => ({
    meta: [
      { title: "Prayer Times | Masjid Al-Noor" },
      {
        name: "description",
        content:
          "Live daily adhan and iqamah times, Jummah schedule, announcements and reminders for our community masjid.",
      },
      { property: "og:title", content: "Prayer Times | Masjid Al-Noor" },
      {
        property: "og:description",
        content: "Live daily adhan and iqamah times, Jummah schedule and announcements.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function playChime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.55;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.5);
    });
  } catch {
    /* audio unavailable */
  }
}

function Home() {
  const { data } = useSuspenseQuery(masjidQuery);
  const queryClient = useQueryClient();
  const now = useNow();

  const [adminOpen, setAdminOpen] = useState(false);
  const [tapPulse, setTapPulse] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const taps = useRef<number[]>([]);
  const lastAnnounced = useRef<string>("");

  useEffect(() => {
    const channel = supabase
      .channel("prayer-settings-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "prayer_settings" }, () => {
        queryClient.invalidateQueries({ queryKey: ["masjid"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const settings = data.settings;
  const prayers = settings ? buildPrayers(settings) : [];
  const status = now && prayers.length ? computeStatus(prayers, now) : null;
  const next = status ? prayers[status.nextIndex] : undefined;

  const defaults = settings as unknown as { default_theme?: string; show_pattern?: boolean } | null;
  const [theme, setTheme] = useState<ThemeId>("emerald");
  const [pattern, setPattern] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const fallback = defaults?.default_theme;
    const initial: ThemeId = isThemeId(stored)
      ? stored
      : isThemeId(fallback)
        ? fallback
        : "emerald";
    setTheme(initial);
    applyTheme(initial);

    const storedPattern = localStorage.getItem(PATTERN_STORAGE_KEY);
    setPattern(storedPattern === null ? (defaults?.show_pattern ?? true) : storedPattern === "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults?.default_theme, defaults?.show_pattern]);

  const changeTheme = useCallback((t: ThemeId) => {
    setTheme(t);
    applyTheme(t);
    localStorage.setItem(THEME_STORAGE_KEY, t);
  }, []);

  const changePattern = useCallback((value: boolean) => {
    setPattern(value);
    localStorage.setItem(PATTERN_STORAGE_KEY, value ? "1" : "0");
  }, []);

  const iqamahAlert = now && prayers.length ? upcomingIqamah(prayers, now) : null;

  useEffect(() => {
    if (!soundOn || !status || !next || !now) return;
    if (status.secondsToNext > 1) return;
    const stamp = `${now.toDateString()}-${next.key}`;
    if (lastAnnounced.current === stamp) return;
    lastAnnounced.current = stamp;
    playChime();
  }, [soundOn, status, next, now]);

  const handleNameTap = useCallback(() => {
    const t = Date.now();
    taps.current = [...taps.current.filter((x) => t - x < 4000), t];
    setTapPulse(true);
    setTimeout(() => setTapPulse(false), 140);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(12);
    if (taps.current.length >= 5) {
      taps.current = [];
      setAdminOpen(true);
    }
  }, []);

  const toggleKiosk = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setKiosk(true);
      } else {
        await document.exitFullscreen();
        setKiosk(false);
      }
    } catch {
      setKiosk((k) => !k);
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (!settings) return;
    const lines = [
      `${settings.masjid_name} — Today's prayer times`,
      ...buildPrayers(settings).map(
        (p) => `${p.name}: Adhan ${formatTime(p.adhan)} · Iqamah ${formatTime(p.iqamah)}`,
      ),
      `Jummah: Khutbah ${formatTime(settings.jummah_khutbah)} · Salah ${formatTime(settings.jummah_salah)}`,
      typeof window !== "undefined" ? window.location.href : "",
    ].join("\n");

    if (navigator.share) {
      try {
        await navigator.share({ title: settings.masjid_name, text: lines });
        return;
      } catch {
        /* fall through */
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(lines)}`, "_blank", "noopener");
  }, [settings]);

  if (!settings) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8 text-center">
        <p className="text-muted-foreground">Prayer times have not been set up yet.</p>
      </main>
    );
  }

  const clock = now
    ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "--:--:--";
  const gregorian = now
    ? now.toLocaleDateString([], {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  return (
    <main className={kiosk ? "min-h-screen px-4 py-6 sm:px-8" : "min-h-screen px-4 py-8 sm:px-8"}>
      {pattern && (
        <div
          className="pattern-geometric pointer-events-none fixed inset-0 -z-10 opacity-40"
          aria-hidden
        />
      )}

      <div className="mx-auto w-full max-w-[1600px] space-y-8">
        <div className="flex justify-end">
          <ThemePicker
            theme={theme}
            onThemeChange={changeTheme}
            pattern={pattern}
            onPatternChange={changePattern}
          />
        </div>
        <header className="flex flex-col items-center gap-3 text-center">
          <button
            onClick={handleNameTap}
            title="Masjid"
            className={`group rounded-2xl px-4 py-2 transition-transform duration-200 ${
              tapPulse ? "scale-[0.97]" : "scale-100"
            }`}
          >
            <span className="flex items-center justify-center gap-3">
              <Moon className="size-7 text-gold transition-opacity group-active:opacity-70 xl:size-9" />
              <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl xl:text-7xl">
                {settings.masjid_name}
              </h1>
            </span>
          </button>
          <p className="text-2xl font-light tabular-nums text-gold-soft sm:text-3xl xl:text-5xl">
            {clock}
          </p>
          <p className="text-sm text-muted-foreground xl:text-lg">
            {gregorian}
            {now ? ` · ${hijriDate(now)}` : ""}
          </p>
        </header>

        {iqamahAlert && <SilentBanner alert={iqamahAlert} />}

        {settings.announcement_visible && settings.announcement.trim() && (
          <div className="rounded-2xl border border-gold/40 bg-gold/10 px-5 py-4 text-center text-base text-gold-soft xl:text-xl">
            {settings.announcement}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex flex-col items-center justify-center rounded-3xl border border-border bg-card/70 p-8 shadow-elegant backdrop-blur">
            <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">Next prayer</p>
            <div className="mt-6">
              <ProgressRing progress={status?.progress ?? 0} size={260}>
                <p className="font-display text-4xl font-semibold text-foreground xl:text-5xl">
                  {next?.name ?? "—"}
                </p>
                <p className="text-arabic mt-1 text-xl text-gold">{next?.arabic ?? ""}</p>
                <p className="mt-3 text-3xl font-light tabular-nums text-gold-soft xl:text-4xl">
                  {status ? formatCountdown(status.secondsToNext) : "--:--:--"}
                </p>
              </ProgressRing>
            </div>
            <p className="mt-6 text-sm text-muted-foreground xl:text-lg">
              {next ? `Adhan at ${formatTime(next.adhan)} · Iqamah ${formatTime(next.iqamah)}` : ""}
            </p>
          </div>

          <div className="overflow-hidden rounded-3xl border border-border bg-card/70 shadow-elegant backdrop-blur">
            <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 border-b border-border px-6 py-4 text-xs uppercase tracking-[0.2em] text-muted-foreground xl:text-sm">
              <span>Prayer</span>
              <span className="text-center">Adhan</span>
              <span className="text-center">Iqamah</span>
            </div>
            {prayers.map((p, i) => {
              const isNext = status?.nextIndex === i;
              const isCurrent = status?.currentIndex === i;
              return (
                <div
                  key={p.key}
                  className={`grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 border-b border-border/60 px-6 py-5 transition-colors last:border-b-0 ${
                    isNext
                      ? "ring-gold bg-gold/10"
                      : isCurrent
                        ? "bg-primary/20"
                        : "hover:bg-secondary/40"
                  }`}
                >
                  <div className="flex items-baseline gap-3">
                    <span className="font-display text-2xl font-semibold text-foreground xl:text-4xl">
                      {p.name}
                    </span>
                    <span className="text-arabic text-lg text-muted-foreground xl:text-2xl">
                      {p.arabic}
                    </span>
                  </div>
                  <span className="text-center text-xl tabular-nums text-foreground xl:text-3xl">
                    {formatTime(p.adhan)}
                  </span>
                  <span
                    className={`text-center text-xl font-medium tabular-nums xl:text-3xl ${
                      isNext ? "text-gold" : "text-gold-soft"
                    }`}
                  >
                    {formatTime(p.iqamah)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="rounded-3xl border border-gold/30 bg-emerald-deep/60 p-8 text-center shadow-elegant">
            <p className="text-xs uppercase tracking-[0.35em] text-gold">Jummah</p>
            <p className="text-arabic mt-3 text-3xl text-gold-soft">الجمعة</p>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground xl:text-base">Khutbah</p>
                <p className="font-display text-3xl font-semibold text-foreground xl:text-5xl">
                  {formatTime(settings.jummah_khutbah)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground xl:text-base">Salah</p>
                <p className="font-display text-3xl font-semibold text-gold xl:text-5xl">
                  {formatTime(settings.jummah_salah)}
                </p>
              </div>
            </div>
          </div>

          <RemindersCard reminders={data.reminders} />
        </section>

        <section className="mx-auto w-full lg:max-w-4xl">
          <TasbihWidget />
        </section>

        
      </div>

      <AdminDialog
        open={adminOpen}
        onOpenChange={setAdminOpen}
        settings={settings}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["masjid"] })}
      />
    </main>
  );
}
