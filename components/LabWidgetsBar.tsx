"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { uid } from "@/lib/types";

const TODO_KEY = "fumebook_lab_todos_v1";
const TIMER_KEY = "fumebook_lab_timers_v1";

const TASK_CATEGORIES = [
  "Flash Column",
  "Manual Silica Column",
  "Size-Exclusion / Sephadex Column",
  "Reaction Setup",
  "Workup & Extraction",
  "Rotavap & High-Vac",
  "Recrystallization / Precipitation",
  "NMR / MS Prep",
] as const;

const COUNTDOWN_PRESETS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "2h", ms: 2 * 60 * 60 * 1000 },
] as const;

type TodoTag = { kind: "normal" } | { kind: "high" } | { kind: "code"; code: string };

interface LabTodo {
  id: string;
  text: string;
  done: boolean;
  tag: TodoTag;
  createdAt: string;
}

interface TodoStore {
  items: LabTodo[];
  scratchpad: string;
}

type TimerMode = "stopwatch" | "countdown";
type TimerStatus = "idle" | "running" | "paused" | "done";

interface ActiveTimer {
  mode: TimerMode;
  status: TimerStatus;
  /** Wall-clock ms when the current running segment began. Null while paused. */
  startedAt: number | null;
  /** Milliseconds accumulated before the current running segment. */
  elapsedMs: number;
  durationMs: number;
  category: string;
  customCategory: string;
  experimentCode: string;
  note: string;
}

interface TimerSession {
  id: string;
  category: string;
  experimentCode: string;
  note: string;
  durationMs: number;
  finishedAt: string;
  manual?: boolean;
}

interface TimerStore {
  active: ActiveTimer;
  sessions: TimerSession[];
}

const EMPTY_TODOS: TodoStore = { items: [], scratchpad: "" };

const DEFAULT_ACTIVE: ActiveTimer = {
  mode: "stopwatch",
  status: "idle",
  startedAt: null,
  elapsedMs: 0,
  durationMs: 15 * 60 * 1000,
  category: TASK_CATEGORIES[0],
  customCategory: "",
  experimentCode: "",
  note: "",
};

const EMPTY_TIMERS: TimerStore = { active: DEFAULT_ACTIVE, sessions: [] };

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteMs(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normaliseTag(raw: unknown): TodoTag {
  if (!raw || typeof raw !== "object") return { kind: "normal" };
  const tag = raw as Partial<TodoTag>;
  if (tag.kind === "high") return { kind: "high" };
  if (tag.kind === "code") {
    const code = textOf("code" in tag ? tag.code : "");
    return code ? { kind: "code", code } : { kind: "normal" };
  }
  return { kind: "normal" };
}

function normaliseTodo(raw: unknown): LabTodo | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<LabTodo>;
  const text = textOf(item.text);
  if (!text) return null;
  return {
    id: textOf(item.id) || uid(),
    text,
    done: item.done === true,
    tag: normaliseTag(item.tag),
    createdAt: textOf(item.createdAt) || new Date().toISOString(),
  };
}

function normaliseTodos(raw: unknown): TodoStore {
  if (!raw || typeof raw !== "object") return EMPTY_TODOS;
  const store = raw as Partial<TodoStore>;
  const items = Array.isArray(store.items)
    ? store.items.map(normaliseTodo).filter((item): item is LabTodo => item !== null)
    : [];
  return { items, scratchpad: typeof store.scratchpad === "string" ? store.scratchpad : "" };
}

function normaliseActive(raw: unknown): ActiveTimer {
  if (!raw || typeof raw !== "object") return DEFAULT_ACTIVE;
  const active = raw as Partial<ActiveTimer>;
  const elapsedMs = finiteMs(active.elapsedMs) ?? 0;
  const durationMs = finiteMs(active.durationMs) ?? DEFAULT_ACTIVE.durationMs;
  const startedAt = finiteMs(active.startedAt);
  const status: TimerStatus =
    active.status === "running" || active.status === "paused" || active.status === "done"
      ? active.status
      : "idle";
  return {
    mode: active.mode === "countdown" ? "countdown" : "stopwatch",
    status: status === "running" && startedAt === null ? "paused" : status,
    startedAt: status === "running" ? startedAt : null,
    elapsedMs,
    durationMs: durationMs > 0 ? durationMs : DEFAULT_ACTIVE.durationMs,
    category: textOf(active.category) || DEFAULT_ACTIVE.category,
    customCategory: textOf(active.customCategory),
    experimentCode: textOf(active.experimentCode),
    note: typeof active.note === "string" ? active.note : "",
  };
}

function normaliseSession(raw: unknown): TimerSession | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<TimerSession>;
  const durationMs = finiteMs(item.durationMs);
  const category = textOf(item.category);
  if (durationMs === null || durationMs <= 0 || !category) return null;
  return {
    id: textOf(item.id) || uid(),
    category,
    experimentCode: textOf(item.experimentCode),
    note: textOf(item.note),
    durationMs,
    finishedAt: textOf(item.finishedAt) || new Date().toISOString(),
    ...(item.manual === true ? { manual: true } : {}),
  };
}

function normaliseTimers(raw: unknown): TimerStore {
  if (!raw || typeof raw !== "object") return EMPTY_TIMERS;
  const store = raw as Partial<TimerStore>;
  const sessions = Array.isArray(store.sessions)
    ? store.sessions.map(normaliseSession).filter((item): item is TimerSession => item !== null)
    : [];
  return { active: normaliseActive(store.active), sessions };
}

function createStore<T>(key: string, parse: (raw: unknown) => T, empty: T) {
  let cache: T | null = null;
  const listeners = new Set<() => void>();

  function read(): T {
    if (cache) return cache;
    if (typeof window === "undefined") return empty;
    try {
      const raw = window.localStorage.getItem(key);
      cache = raw ? parse(JSON.parse(raw)) : empty;
    } catch {
      cache = empty;
    }
    return cache;
  }

  function write(next: T) {
    cache = next;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // A full browser store should not block the chemist from using the widgets.
    }
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      cache = null;
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { read, write, subscribe, empty };
}

const todosStore = createStore(TODO_KEY, normaliseTodos, EMPTY_TODOS);
const timersStore = createStore(TIMER_KEY, normaliseTimers, EMPTY_TIMERS);

function useTodoStore(): TodoStore {
  return useSyncExternalStore(todosStore.subscribe, todosStore.read, () => EMPTY_TODOS);
}

function useTimerStore(): TimerStore {
  return useSyncExternalStore(timersStore.subscribe, timersStore.read, () => EMPTY_TIMERS);
}

function elapsedAt(active: ActiveTimer, now: number): number {
  if (active.status !== "running" || active.startedAt === null) return active.elapsedMs;
  return active.elapsedMs + Math.max(0, now - active.startedAt);
}

function categoryLabel(active: Pick<ActiveTimer, "category" | "customCategory">): string {
  if (active.category === "custom") return active.customCategory.trim();
  return active.category.trim();
}

/** Stats use hours and minutes (`2h 54m`). A live clock keeps the seconds. */
function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${Math.max(1, Math.round(safe / 1000))}s`;
  const totalMin = Math.round(safe / 60_000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function tagLabel(tag: TodoTag): string {
  if (tag.kind === "high") return "High / Urgent";
  if (tag.kind === "code") return tag.code;
  return "Normal";
}

let sharedAudio: AudioContext | null = null;

function armTimerAudio() {
  const Ctx = window.AudioContext;
  if (!Ctx) return;
  if (!sharedAudio) sharedAudio = new Ctx();
  void sharedAudio.resume().catch(() => undefined);
}

function playTimerBeep() {
  try {
    armTimerAudio();
    const ctx = sharedAudio;
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.22].forEach((offset, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = index === 0 ? 880 : 1174;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    });
  } catch {
    // Autoplay can block audio until the next click. The on-screen notice still shows.
  }
}

function notifyTimerFinished(category: string, code: string) {
  playTimerBeep();
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const body = code ? `${code} · ${category}` : category;
  try {
    new Notification("Lab timer finished", { body });
  } catch {
    // Notifications are optional.
  }
}

function patchActive(patch: Partial<ActiveTimer>) {
  const current = timersStore.read();
  timersStore.write({ ...current, active: { ...current.active, ...patch } });
}

function completeCountdown() {
  const current = timersStore.read();
  const active = current.active;
  if (active.status !== "running" || active.mode !== "countdown") return;
  if (elapsedAt(active, Date.now()) + 250 < active.durationMs) return;
  timersStore.write({
    ...current,
    active: {
      ...active,
      status: "done",
      startedAt: null,
      elapsedMs: active.durationMs,
    },
  });
  notifyTimerFinished(categoryLabel(active) || "Timer", active.experimentCode);
}

function useTickingNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  return running ? now : Date.now();
}

interface Props {
  /** Open experiment id, e.g. GH055. The timer can link a session to it. */
  experimentCode?: string;
}

function TimerEngine() {
  const timers = useTimerStore();
  const active = timers.active;
  useEffect(() => {
    if (active.status !== "running" || active.mode !== "countdown" || active.startedAt === null) return;
    const remaining = active.durationMs - elapsedAt(active, Date.now());
    if (remaining <= 0) {
      completeCountdown();
      return;
    }
    const id = window.setTimeout(completeCountdown, remaining + 40);
    return () => window.clearTimeout(id);
  }, [active]);
  return null;
}

/** Hazmat to-do note. Lives on the lab dashboard, away from an open experiment. */
export function LabPostIt() {
  return (
    <section className="print:hidden">
      <PostIt />
    </section>
  );
}

/** Column / task timer, shown only when this experiment has the timer widget turned on. */
export function LabTimer({ experimentCode, onRemove }: Props & { onRemove?: () => void }) {
  return <TimerWidget experimentCode={experimentCode} onRemove={onRemove} />;
}

/** Post-it for an experiment page, with a way to dismiss it from that page. */
export function LabTodoWidget({ experimentCode, onRemove }: Props & { onRemove?: () => void }) {
  return (
    <section className="print:hidden">
      <PostIt experimentCode={experimentCode} onRemove={onRemove} />
    </section>
  );
}

interface WidgetRenderProps {
  experimentCode: string;
  onRemove: () => void;
}

/**
 * Modular widgets for an experiment page. Add a row here to offer a new one
 * from "+ Add Widget" (molecular weight, solvent miscibility, vapour pressure, …).
 */
export const LAB_WIDGET_REGISTRY: {
  id: string;
  label: string;
  icon: string;
  render: (props: WidgetRenderProps) => ReactNode;
}[] = [
  {
    id: "timer",
    label: "Lab Timer & Duration Analytics",
    icon: "⏱",
    render: (props) => <LabTimer experimentCode={props.experimentCode} onRemove={props.onRemove} />,
  },
  {
    id: "todo",
    label: "Lab To-Do Post-It & Scratchpad",
    icon: "📌",
    render: (props) => <LabTodoWidget experimentCode={props.experimentCode} onRemove={props.onRemove} />,
  },
];

export function LabWidgetMenu({
  enabled,
  onToggle,
}: {
  enabled: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className="shrink-0 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
      >
        + Add Widget
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-zinc-200 bg-white p-1 shadow-xl">
          {LAB_WIDGET_REGISTRY.map((widget) => {
            const on = enabled.includes(widget.id);
            return (
              <button
                key={widget.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => onToggle(widget.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-50"
              >
                <span className="w-4 text-center text-emerald-700">{on ? "✓" : ""}</span>
                <span className="whitespace-nowrap">
                  {widget.icon} {widget.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Full-width tray above the experiment sheet. Never sits beside the paper. */
export function LabWidgetTray({
  enabled,
  experimentCode,
  onRemove,
}: {
  enabled: string[];
  experimentCode: string;
  onRemove: (id: string) => void;
}) {
  const active = LAB_WIDGET_REGISTRY.filter((widget) => enabled.includes(widget.id));
  if (active.length === 0) return null;
  return (
    <div className="mb-4 grid w-full grid-cols-1 gap-4 print:hidden md:grid-cols-2">
      {active.map((widget) => (
        <div key={widget.id} className={active.length === 1 ? "md:col-span-2" : undefined}>
          {widget.render({ experimentCode, onRemove: () => onRemove(widget.id) })}
        </div>
      ))}
    </div>
  );
}

/** Keeps a running countdown accurate and fires the beep even when the timer card is off-screen. */
export function LabTimerEngine() {
  return <TimerEngine />;
}

function RemoveWidgetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 whitespace-nowrap rounded-md border border-zinc-200 bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-white hover:text-zinc-800"
    >
      × Remove widget
    </button>
  );
}

function PostIt({ experimentCode, onRemove }: { experimentCode?: string; onRemove?: () => void }) {
  const todos = useTodoStore();
  const [draft, setDraft] = useState("");
  const [tagKind, setTagKind] = useState<"normal" | "high" | "code">("normal");
  const [code, setCode] = useState(experimentCode ?? "");
  const [tab, setTab] = useState<"tasks" | "scratch">("tasks");
  const dragId = useRef<string | null>(null);
  const doneCount = todos.items.filter((item) => item.done).length;

  function addTodo() {
    const text = draft.trim();
    if (!text) return;
    const tag: TodoTag =
      tagKind === "high"
        ? { kind: "high" }
        : tagKind === "code" && (code.trim() || experimentCode)
          ? { kind: "code", code: (code.trim() || experimentCode || "").toUpperCase() }
          : { kind: "normal" };
    todosStore.write({
      ...todosStore.read(),
      items: [
        {
          id: uid(),
          text,
          done: false,
          tag,
          createdAt: new Date().toISOString(),
        },
        ...todosStore.read().items,
      ],
    });
    setDraft("");
  }

  function toggle(id: string) {
    const current = todosStore.read();
    todosStore.write({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    });
  }

  function pin(id: string) {
    const current = todosStore.read();
    const item = current.items.find((row) => row.id === id);
    if (!item) return;
    todosStore.write({
      ...current,
      items: [{ ...item, tag: { kind: "high" } }, ...current.items.filter((row) => row.id !== id)],
    });
  }

  function dropOn(targetId: string) {
    const fromId = dragId.current;
    dragId.current = null;
    if (!fromId || fromId === targetId) return;
    const current = todosStore.read();
    const items = [...current.items];
    const from = items.findIndex((item) => item.id === fromId);
    const to = items.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    todosStore.write({ ...current, items });
  }

  return (
    <section className="rounded-md border border-amber-200 border-l-4 border-l-amber-400 bg-amber-50/90 p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
            Lab To-Do
          </span>
          <h2 className="text-sm font-semibold text-amber-950">Post-It</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {onRemove && <RemoveWidgetButton onClick={onRemove} />}
          <div className="flex rounded-md bg-amber-100/80 p-0.5 text-[10px] font-semibold">
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
            Tasks
          </TabButton>
          <TabButton active={tab === "scratch"} onClick={() => setTab("scratch")}>
            Scratchpad
          </TabButton>
          </div>
        </div>
      </div>

      {tab === "tasks" ? (
        <>
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              addTodo();
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Add a task…"
              aria-label="New lab task"
              className="min-w-[10rem] flex-1 rounded-md border border-amber-300/80 bg-white/80 px-2 py-1 text-sm text-zinc-900 placeholder:text-amber-800/40 focus:border-amber-500 focus:outline-none"
            />
            <select
              value={tagKind}
              onChange={(event) => setTagKind(event.target.value as "normal" | "high" | "code")}
              aria-label="Task priority"
              className="rounded-md border border-amber-300/80 bg-white/80 px-1.5 py-1 text-xs text-zinc-800 focus:border-amber-500 focus:outline-none"
            >
              <option value="normal">Normal</option>
              <option value="high">High / Urgent</option>
              <option value="code">Experiment code</option>
            </select>
            {tagKind === "code" && (
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={experimentCode || "GH055"}
                aria-label="Linked experiment code"
                className="w-20 rounded-md border border-amber-300/80 bg-white/80 px-1.5 py-1 font-mono text-xs uppercase text-zinc-900 placeholder:text-amber-800/40 focus:border-amber-500 focus:outline-none"
              />
            )}
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-800"
            >
              Add
            </button>
          </form>

          {todos.items.length === 0 ? (
            <p className="mt-3 text-xs text-amber-900/70">Nothing on the post-it yet.</p>
          ) : (
            <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">
              {todos.items.map((item) => (
                <li
                  key={item.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => dropOn(item.id)}
                  className="flex items-start gap-1.5 rounded-md bg-white/60 px-1.5 py-1"
                >
                  <button
                    type="button"
                    draggable
                    aria-label={`Drag to reorder ${item.text}`}
                    onDragStart={(event) => {
                      dragId.current = item.id;
                      event.dataTransfer.setData("text/plain", item.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    className="mt-0.5 cursor-grab px-0.5 text-xs text-amber-700/70 active:cursor-grabbing"
                  >
                    ⋮⋮
                  </button>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => toggle(item.id)}
                    aria-label={item.done ? `Mark not done: ${item.text}` : `Mark done: ${item.text}`}
                    className="mt-1 accent-emerald-700"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${item.done ? "text-zinc-400 line-through" : "text-zinc-900"}`}>
                      {item.text}
                    </p>
                    <span
                      className={`mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        item.tag.kind === "high"
                          ? "bg-amber-200 text-amber-950"
                          : item.tag.kind === "code"
                            ? "bg-emerald-50 font-mono text-emerald-800 ring-1 ring-emerald-200"
                            : "bg-amber-100/80 text-amber-800"
                      }`}
                    >
                      {tagLabel(item.tag)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => pin(item.id)}
                    title="Pin to the top as High / Urgent"
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 hover:bg-amber-200/80"
                  >
                    Pin
                  </button>
                </li>
              ))}
            </ul>
          )}

          {doneCount > 0 && (
            <button
              type="button"
              onClick={() => {
                const current = todosStore.read();
                todosStore.write({ ...current, items: current.items.filter((item) => !item.done) });
              }}
              className="mt-2 text-[11px] font-semibold text-amber-900 underline-offset-2 hover:underline"
            >
              Clear completed ({doneCount})
            </button>
          )}
        </>
      ) : (
        <textarea
          value={todos.scratchpad}
          onChange={(event) => {
            const current = todosStore.read();
            todosStore.write({ ...current, scratchpad: event.target.value });
          }}
          rows={6}
          placeholder={"Tare 12.43 g\nFractions 12–19 = spot A\nNMR queue slot 4"}
          aria-label="Scratchpad"
          className="w-full resize-y rounded-md border border-amber-300/80 bg-white/70 px-2 py-1.5 text-sm leading-relaxed text-zinc-900 placeholder:text-amber-800/40 focus:border-amber-500 focus:outline-none"
        />
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 ${active ? "bg-white text-amber-950 shadow-sm" : "text-amber-900/70"}`}
    >
      {children}
    </button>
  );
}

function TimerWidget({ experimentCode, onRemove }: { experimentCode?: string; onRemove?: () => void }) {
  const store = useTimerStore();
  const active = store.active;
  const running = active.status === "running";
  const now = useTickingNow(running);
  const [view, setView] = useState<"clock" | "stats">("clock");
  const elapsed = elapsedAt(active, now);
  const shown = active.mode === "countdown" ? Math.max(0, active.durationMs - elapsed) : elapsed;
  const label = categoryLabel(active);

  function startOrPause() {
    const current = timersStore.read().active;
    if (current.status === "running") {
      patchActive({
        status: "paused",
        startedAt: null,
        elapsedMs: elapsedAt(current, Date.now()),
      });
      return;
    }
    const nextLabel = categoryLabel(current);
    if (!nextLabel) return;
    if (current.mode === "countdown") {
      armTimerAudio();
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission().catch(() => undefined);
      }
    }
    const restart = current.status === "done" || (current.mode === "countdown" && current.elapsedMs >= current.durationMs);
    patchActive({
      status: "running",
      startedAt: Date.now(),
      elapsedMs: restart ? 0 : current.elapsedMs,
      experimentCode: current.experimentCode || experimentCode || "",
    });
  }

  function finishAndLog() {
    const current = timersStore.read();
    const logged = Math.min(
      elapsedAt(current.active, Date.now()),
      current.active.mode === "countdown" ? current.active.durationMs : Number.POSITIVE_INFINITY,
    );
    if (logged < 1000) return;
    const name = categoryLabel(current.active);
    if (!name) return;
    const session: TimerSession = {
      id: uid(),
      category: name,
      experimentCode: current.active.experimentCode,
      note: current.active.note.trim(),
      durationMs: logged,
      finishedAt: new Date().toISOString(),
    };
    timersStore.write({
      ...current,
      sessions: [session, ...current.sessions],
      active: {
        ...current.active,
        status: "idle",
        startedAt: null,
        elapsedMs: 0,
      },
    });
  }

  function resetTimer() {
    patchActive({ status: "idle", startedAt: null, elapsedMs: 0 });
  }

  const loggedMs = Math.min(
    elapsed,
    active.mode === "countdown" ? active.durationMs : Number.POSITIVE_INFINITY,
  );

  return (
    <section className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
            Lab Timer
          </span>
          <h2 className="text-sm font-semibold text-zinc-900">Task duration</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {onRemove && <RemoveWidgetButton onClick={onRemove} />}
          <div className="flex rounded-md bg-zinc-100 p-0.5 text-[10px] font-semibold">
          <button
            type="button"
            onClick={() => setView("clock")}
            className={`rounded px-2 py-0.5 ${view === "clock" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
          >
            Timer
          </button>
          <button
            type="button"
            onClick={() => setView("stats")}
            className={`rounded px-2 py-0.5 ${view === "stats" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
          >
            Analytics
          </button>
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-2">
        <p
          className={`font-mono text-3xl font-semibold tracking-tight ${
            active.status === "done" ? "text-amber-700" : "text-zinc-900"
          }`}
        >
          {formatClock(shown)}
        </p>
        <p className="pb-1 text-[11px] font-medium text-zinc-500">
          {active.status === "done"
            ? "Time's up"
            : active.mode === "countdown"
              ? "Countdown"
              : "Stopwatch"}
        </p>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={startOrPause}
          disabled={!label}
          className="rounded-md bg-fume-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-fume-700 disabled:opacity-40"
        >
          {running ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          onClick={finishAndLog}
          disabled={loggedMs < 1000}
          className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
        >
          Finish & Log Time
        </button>
        <button
          type="button"
          onClick={resetTimer}
          disabled={active.status === "idle" && active.elapsedMs === 0}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      {view === "clock" ? (
        <TimerSetup active={active} experimentCode={experimentCode} running={running} />
      ) : (
        <TimerAnalytics sessions={store.sessions} />
      )}
    </section>
  );
}

function TimerSetup({
  active,
  experimentCode,
  running,
}: {
  active: ActiveTimer;
  experimentCode?: string;
  running: boolean;
}) {
  const custom = active.category === "custom";
  return (
    <div className="mt-3 space-y-2">
      <div className="flex rounded-md bg-zinc-100 p-0.5 text-xs font-semibold">
        <ModeButton
          active={active.mode === "stopwatch"}
          disabled={running}
          onClick={() => patchActive({ mode: "stopwatch", status: "idle", startedAt: null, elapsedMs: 0 })}
        >
          Stopwatch
        </ModeButton>
        <ModeButton
          active={active.mode === "countdown"}
          disabled={running}
          onClick={() => patchActive({ mode: "countdown", status: "idle", startedAt: null, elapsedMs: 0 })}
        >
          Countdown
        </ModeButton>
      </div>

      {active.mode === "countdown" && (
        <div className="flex flex-wrap gap-1">
          {COUNTDOWN_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={running}
              onClick={() =>
                patchActive({
                  durationMs: preset.ms,
                  status: "idle",
                  startedAt: null,
                  elapsedMs: 0,
                })
              }
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                active.durationMs === preset.ms
                  ? "bg-fume-600 text-white"
                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
              } disabled:opacity-40`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      <label className="block text-[11px] font-medium text-zinc-500">
        Task category
        <span className="mt-1 flex gap-1.5">
          <select
            value={custom ? "custom" : active.category}
            onChange={(event) => {
              const value = event.target.value;
              patchActive(value === "custom" ? { category: "custom" } : { category: value, customCategory: "" });
            }}
            aria-label="Task category"
            className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 focus:border-fume-500 focus:outline-none"
          >
            {TASK_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
            <option value="custom">Custom tag…</option>
          </select>
        </span>
      </label>
      {custom && (
        <input
          value={active.customCategory}
          onChange={(event) => patchActive({ customCategory: event.target.value })}
          placeholder="Custom task tag"
          aria-label="Custom task tag"
          className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm focus:border-fume-500 focus:outline-none"
        />
      )}

      <div className="flex gap-1.5">
        <input
          value={active.experimentCode}
          onChange={(event) => patchActive({ experimentCode: event.target.value.toUpperCase() })}
          placeholder={experimentCode || "GH055"}
          aria-label="Linked experiment code"
          className="w-24 rounded-md border border-zinc-200 px-2 py-1 font-mono text-xs uppercase focus:border-fume-500 focus:outline-none"
        />
        {experimentCode && active.experimentCode !== experimentCode && (
          <button
            type="button"
            onClick={() => patchActive({ experimentCode })}
            className="rounded-md border border-fume-200 bg-fume-50 px-2 py-1 text-[11px] font-semibold text-fume-800 hover:bg-fume-100"
          >
            Use {experimentCode}
          </button>
        )}
        <input
          value={active.note}
          onChange={(event) => patchActive({ note: event.target.value })}
          placeholder="DCM/MeOH 9:1 gradient"
          aria-label="Timer note"
          className="min-w-0 flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-fume-500 focus:outline-none"
        />
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1 ${active ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

function TimerAnalytics({ sessions }: { sessions: TimerSession[] }) {
  const [manualOpen, setManualOpen] = useState(false);
  const groups = categoryStats(sessions);
  const maxTotal = groups.reduce((max, group) => Math.max(max, group.total), 0);

  return (
    <div className="mt-3 space-y-3">
      {groups.length === 0 ? (
        <p className="text-xs text-zinc-500">No timed sessions yet. Finish a timer, or log one by hand.</p>
      ) : (
        <ul className="space-y-2.5">
          {groups.map((group) => (
            <li key={group.category}>
              <p className="text-xs font-medium text-zinc-800">
                {group.category}: Avg {formatDuration(group.avg)} across {group.count}{" "}
                {group.count === 1 ? "run" : "runs"}
              </p>
              <p className="text-[11px] text-zinc-500">
                Min {formatDuration(group.min)} · Max {formatDuration(group.max)} · Total{" "}
                {formatDuration(group.total)}
              </p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full bg-emerald-600"
                  style={{ width: `${maxTotal > 0 ? Math.max(6, (group.total / maxTotal) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Recent sessions</h3>
          <button
            type="button"
            onClick={() => setManualOpen((value) => !value)}
            className="text-[11px] font-semibold text-fume-700 hover:underline"
          >
            + Log manual entry
          </button>
        </div>
        {manualOpen && <ManualEntryForm onDone={() => setManualOpen(false)} />}
        {sessions.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {[...sessions]
              .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
              .map((session) => (
                <li key={session.id} className="flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-1">
                  <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-zinc-700">
                    <span className="text-zinc-400">{formatSessionDate(session.finishedAt)}</span>
                    {session.experimentCode && (
                      <span className="ml-1.5 font-mono font-semibold text-zinc-900">{session.experimentCode}</span>
                    )}
                    <span className="ml-1.5">{session.category}</span>
                    <span className="ml-1.5 font-semibold text-zinc-900">{formatDuration(session.durationMs)}</span>
                    {session.note && <span className="mt-0.5 block text-zinc-500">{session.note}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const current = timersStore.read();
                      timersStore.write({
                        ...current,
                        sessions: current.sessions.filter((item) => item.id !== session.id),
                      });
                    }}
                    aria-label={`Delete ${session.category} session`}
                    className="shrink-0 text-[11px] font-medium text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function categoryStats(sessions: TimerSession[]) {
  const grouped = new Map<string, number[]>();
  for (const session of sessions) {
    const list = grouped.get(session.category) ?? [];
    list.push(session.durationMs);
    grouped.set(session.category, list);
  }
  return [...grouped.entries()]
    .map(([category, durations]) => {
      const total = durations.reduce((sum, value) => sum + value, 0);
      return {
        category,
        count: durations.length,
        avg: total / durations.length,
        min: Math.min(...durations),
        max: Math.max(...durations),
        total,
      };
    })
    .sort((a, b) => b.total - a.total);
}

function ManualEntryForm({ onDone }: { onDone: () => void }) {
  const [category, setCategory] = useState<string>(TASK_CATEGORIES[1]);
  const [custom, setCustom] = useState("");
  const [hours, setHours] = useState("3");
  const [minutes, setMinutes] = useState("00");
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const name = (category === "custom" ? custom : category).trim();
    const h = Number(hours);
    const m = Number(minutes);
    const durationMs = (Number.isFinite(h) ? h : 0) * 3_600_000 + (Number.isFinite(m) ? m : 0) * 60_000;
    if (!name || durationMs <= 0) {
      setError("Enter a category and a duration.");
      return;
    }
    const current = timersStore.read();
    timersStore.write({
      ...current,
      sessions: [
        {
          id: uid(),
          category: name,
          experimentCode: code.trim().toUpperCase(),
          note: note.trim(),
          durationMs,
          finishedAt: new Date().toISOString(),
          manual: true,
        },
        ...current.sessions,
      ],
    });
    onDone();
  }

  return (
    <form
      className="mb-2 space-y-1.5 rounded-md border border-zinc-200 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <select
        value={category}
        onChange={(event) => setCategory(event.target.value)}
        aria-label="Manual entry category"
        className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-fume-500 focus:outline-none"
      >
        {TASK_CATEGORIES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
        <option value="custom">Custom tag…</option>
      </select>
      {category === "custom" && (
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Custom task tag"
          aria-label="Custom manual category"
          className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-fume-500 focus:outline-none"
        />
      )}
      <div className="flex gap-1.5">
        <input
          value={hours}
          onChange={(event) => setHours(event.target.value)}
          inputMode="numeric"
          aria-label="Hours"
          className="w-16 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-fume-500 focus:outline-none"
        />
        <span className="self-center text-[11px] text-zinc-500">h</span>
        <input
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          inputMode="numeric"
          aria-label="Minutes"
          className="w-16 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-fume-500 focus:outline-none"
        />
        <span className="self-center text-[11px] text-zinc-500">m</span>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="GH055"
          aria-label="Manual entry experiment code"
          className="w-20 rounded-md border border-zinc-200 px-2 py-1 font-mono text-xs uppercase focus:border-fume-500 focus:outline-none"
        />
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <button
        type="submit"
        className="rounded-md bg-fume-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-fume-700"
      >
        Save entry
      </button>
    </form>
  );
}
