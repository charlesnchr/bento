// The replay view: a recorded call (a trace from any host, or a scenario) run again through the
// core, as the build that recorded it did and as the latest does, side by side. Where they part
// is where a change in src/ changed what the call does with the same words and the same model.

interface Core {
  version: string;
  create(config: string, t: number): string;
  push(id: number, event: string): string;
}

interface Recording { version?: string; config: unknown; start: number; events: Record<string, any>[] }

/** What a command or event looks like in a timeline: audio cut out, one line. */
function line(o: Record<string, any>): string {
  const text = JSON.stringify(o).replace(/"(data|pcm)":"[A-Za-z0-9+/=]{40,}"/g, '"$1":"…"')
    .replace(/\\"data\\":\\"[A-Za-z0-9+/=]{40,}\\"/g, '\\"data\\":\\"…\\"');
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

/** Audio and ticks say nothing a reader needs; the rest does. */
function telling(o: Record<string, any>): boolean {
  if (o.type === "mic" || o.type === "tick" || o.type === "play") return false;
  if (o.type === "ws.send" && String(o.data).startsWith('{"realtimeInput":{"audio"')) return false;
  if (o.type === "ws.message" && String(o.data).includes('"inlineData"') && !String(o.data).includes('"turnComplete"')) return false;
  return true;
}

function run(core: Core, r: Recording): string[][] {
  const created = JSON.parse(core.create(JSON.stringify(r.config), r.start));
  const out: string[][] = [created.commands.filter(telling).map(line)];
  for (const e of r.events) out.push((JSON.parse(core.push(created.id, JSON.stringify(e))) as Record<string, any>[]).filter(telling).map(line));
  return out;
}

export class Replay {
  private readonly root: HTMLElement;
  private readonly load: (url?: string) => Promise<Core>;

  constructor(root: HTMLElement, load: (url?: string) => Promise<Core>) {
    this.root = root;
    this.load = load;
    root.innerHTML = `
      <div class="bar"><select class="pick"></select><button class="refresh">↻</button><button class="go">Replay</button>
      <label><input type="checkbox" class="all"> show audio and ticks</label><span class="summary"></span></div>
      <div class="timeline"></div>`;
    (root.querySelector(".refresh") as HTMLElement).onclick = () => void this.list();
    (root.querySelector(".go") as HTMLElement).onclick = () => void this.replay().catch((err) => this.say(`Replay failed: ${err.message}`));
    void this.list();
  }

  private say(text: string) {
    (this.root.querySelector(".summary") as HTMLElement).textContent = text;
  }

  private async list() {
    const pick = this.root.querySelector(".pick") as HTMLSelectElement;
    pick.innerHTML = "";
    const traces: { name: string; bytes: number }[] = await (await fetch("/traces")).json();
    const scenarios: string[] = await (await fetch("/scenarios")).json();
    const traceGroup = document.createElement("optgroup");
    traceGroup.label = "Recorded calls";
    for (const t of traces) traceGroup.append(new Option(`${t.name} (${Math.round(t.bytes / 1024)} KB)`, `/traces/${t.name}`));
    const scenarioGroup = document.createElement("optgroup");
    scenarioGroup.label = "Scenarios";
    for (const s of scenarios) scenarioGroup.append(new Option(s, `/scenarios/${s}.json`));
    pick.append(traceGroup, scenarioGroup);
  }

  private async recording(url: string): Promise<Recording> {
    const text = await (await fetch(url, { cache: "no-store" })).text();
    if (url.endsWith(".json")) return JSON.parse(text);
    const [header, ...events] = text.trim().split("\n").map((l) => JSON.parse(l));
    return { ...header, events };
  }

  private async replay() {
    const url = (this.root.querySelector(".pick") as HTMLSelectElement).value;
    if (!url) return;
    const r = await this.recording(url);
    const latest = await this.load();
    let recorded: Core | null = null;
    if (r.version && r.version !== latest.version) {
      const response = await fetch(`/versions/${r.version}.js`, { method: "HEAD" });
      if (response.ok) recorded = await this.load(`/versions/${r.version}.js`);
    }
    const now = run(latest, r);
    const then = recorded ? run(recorded, r) : null;
    const all = (this.root.querySelector(".all") as HTMLInputElement).checked;
    const timeline = this.root.querySelector(".timeline") as HTMLElement;
    timeline.innerHTML = "";
    let first = -1;
    let differ = 0;
    const rows: HTMLElement[] = [];
    const add = (cls: string, t: string, text: string) => {
      const row = document.createElement("div");
      row.className = `row ${cls}`;
      row.innerHTML = `<span class="t">${t}</span>`;
      const b = document.createElement("span");
      b.className = "b";
      b.textContent = text;
      row.append(b);
      timeline.append(row);
      rows.push(row);
      return row;
    };
    const t0 = r.start;
    for (let i = 0; i <= r.events.length; i++) {
      const e = i === 0 ? null : r.events[i - 1];
      const nowOut = now[i];
      const thenOut = then ? then[i] : nowOut;
      const same = nowOut.length === thenOut.length && nowOut.every((c, j) => c === thenOut[j]);
      if (!same) { differ++; if (first < 0) first = i; }
      if (!same || all || (e && telling(e)) || nowOut.length > 0) {
        if (e && (all || telling(e) || !same)) add("in", (e.t - t0).toFixed(2), line(e));
        const t = e ? (e.t - t0).toFixed(2) : "0.00";
        if (same) for (const c of nowOut) add("out", t, c);
        else {
          for (const c of thenOut) add("out gone", t, `− ${c}`);
          for (const c of nowOut) add("out new", t, `+ ${c}`);
        }
      }
    }
    const versions = then ? `recorded by ${r.version}, replayed by it and by ${latest.version}` : `replayed by ${latest.version}` +
      (r.version && r.version !== latest.version ? ` (the recording's build ${r.version} isn't kept here)` : "");
    this.say(`${r.events.length} events, ${versions}. ` + (then ? (differ ? `${differ} events answered differently, the first at event ${first}.` : "Both answered every event the same.") : ""));
    if (first >= 0) timeline.querySelector(".gone, .new")?.scrollIntoView({ block: "center" });
  }
}
