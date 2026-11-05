import ICAL from "ical.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { type CalendarStatus, type Meeting, calendarConnectRpc, calendarDisconnectRpc, calendarTodayRpc } from "../shared/calendar-rpc";
import type { createKeyStore } from "./keys";

/** The key the calendar address is kept under in the Keys panel. */
export const CALENDAR_ENV = "GOOGLE_CALENDAR_ICS";
const CACHE_MS = 5 * 60_000;
const MAX_STEPS = 20_000;
const JOIN = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/[jw]\/[^\s"<>)]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>)]+|teams\.live\.com\/meet\/[^\s"<>)]+)/i;

type KeyStore = ReturnType<typeof createKeyStore>;
type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Calendar text without HTML, entities, or Google's boilerplate footer. */
export function plainDescription(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/-::~:~::~:~:~:~[\s\S]*?-::~:~::~:~:~:~[^\n]*\n?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}

function email(value: unknown): string {
  return String(value ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
}

/**
 * The meetings in an iCalendar file that overlap [from, to): recurring ones
 * expanded with their moved and cancelled occurrences, declined ones left out.
 */
export function meetingsBetween(ics: string, from: number, to: number): { name: string; meetings: Meeting[] } {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone);
  const name = String(root.getFirstPropertyValue("x-wr-calname") ?? "");
  const self = email(name);
  const events = root.getAllSubcomponents("vevent").map((component) => new ICAL.Event(component));
  const masters = new Map<string, ICAL.Event>();
  for (const event of events) if (!event.isRecurrenceException()) masters.set(event.uid, event);
  for (const event of events) if (event.isRecurrenceException()) masters.get(event.uid)?.relateException(event);

  const meetings: Meeting[] = [];
  const add = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time) => {
    const startMs = start.toJSDate().getTime();
    const endMs = end.toJSDate().getTime();
    if (endMs <= from || startMs >= to) return;
    if (String(item.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const attendees = item.attendees.map((property) => ({
      name: String(property.getParameter("cn") ?? ""),
      email: email(property.getFirstValue()),
      status: String(property.getParameter("partstat") ?? "").toLowerCase(),
    }));
    const me = attendees.find((attendee) => attendee.email === self);
    if (me?.status === "declined") return;
    const location = String(item.location ?? "");
    const rawDescription = String(item.description ?? "");
    const conference = String(item.component.getFirstPropertyValue("x-google-conference") ?? "");
    const joinUrl = (conference && JOIN.test(conference) ? conference : null) ?? location.match(JOIN)?.[0] ?? rawDescription.match(JOIN)?.[0] ?? null;
    meetings.push({
      id: `${item.uid}:${startMs}`,
      title: String(item.summary ?? "(no title)"),
      start: startMs,
      end: endMs,
      allDay: start.isDate,
      location,
      description: plainDescription(rawDescription),
      joinUrl,
      organizer: email(item.organizer),
      attendees: attendees.filter((attendee) => attendee.email !== self && !attendee.email.endsWith("resource.calendar.google.com")),
      myStatus: me?.status ?? "",
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate);
      continue;
    }
    const iterator = event.iterator();
    for (let step = 0, next = iterator.next(); next && step < MAX_STEPS; step++, next = iterator.next()) {
      if (next.toJSDate().getTime() >= to) break;
      const details = event.getOccurrenceDetails(next);
      add(details.item, details.startDate, details.endDate);
    }
  }
  meetings.sort((left, right) => left.start - right.start || left.end - right.end);
  return { name, meetings };
}

/** Start of today and end of tomorrow, in this machine's time zone. */
export function todayWindow(now: number): { from: number; to: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  return { from: start.getTime(), to: end.getTime() };
}

export function createCalendar(options: { keys: KeyStore; fetcher?: Fetch; now?: () => number }) {
  const fetcher = options.fetcher ?? (fetch as unknown as Fetch);
  const now = options.now ?? Date.now;
  let cache: { at: number; ics: string; name: string } | null = null;
  let error: string | null = null;

  const keyId = async () => (await options.keys.list()).find((key) => key.envVar === CALENDAR_ENV)?.id ?? null;
  const download = async (url: string) => {
    const response = await fetcher(url.trim().replace(/^webcal:\/\//i, "https://"));
    if (!response.ok) throw new Error(response.status === 404 ? "The calendar address was not found (404). Copy the secret iCal address again." : `The calendar answered HTTP ${response.status}`);
    const text = await response.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That address is not an iCal calendar. Use the \"Secret address in iCal format\".");
    return text;
  };

  return {
    async today(refresh = false): Promise<{ status: CalendarStatus; meetings: Meeting[] }> {
      const id = await keyId();
      if (!id) return { status: { connected: false, name: "", fetchedAt: null, error: null }, meetings: [] };
      if (refresh || !cache || now() - cache.at > CACHE_MS) {
        try {
          const ics = await download(await options.keys.reveal(id));
          cache = { at: now(), ics, name: "" };
          error = null;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      if (!cache) return { status: { connected: true, name: "", fetchedAt: null, error }, meetings: [] };
      const window = todayWindow(now());
      try {
        const { name, meetings } = meetingsBetween(cache.ics, window.from, window.to);
        return { status: { connected: true, name, fetchedAt: cache.at, error }, meetings };
      } catch (caught) {
        return { status: { connected: true, name: "", fetchedAt: cache.at, error: `Could not read the calendar: ${caught instanceof Error ? caught.message : String(caught)}` }, meetings: [] };
      }
    },
    async connect(url: string): Promise<{ ok: boolean; error: string | null }> {
      try {
        const ics = await download(url);
        meetingsBetween(ics, 0, 1);
        const existing = await keyId();
        await options.keys.save({ ...(existing ? { id: existing } : {}), name: "Google Calendar (iCal)", envVar: CALENDAR_ENV, service: "other", note: "The Today strip's calendar address", value: url.trim() });
        cache = { at: now(), ics, name: "" };
        error = null;
        return { ok: true, error: null };
      } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
      }
    },
    async disconnect() {
      const id = await keyId();
      if (id) await options.keys.remove(id);
      cache = null;
      return true;
    },
  };
}

export function registerCalendarServer(server: PluginServerContext, calendar: ReturnType<typeof createCalendar>): void {
  server.handle(calendarTodayRpc, ({ refresh }) => calendar.today(refresh === true));
  server.handle(calendarConnectRpc, ({ url }) => calendar.connect(url));
  server.handle(calendarDisconnectRpc, async () => ({ ok: await calendar.disconnect() }));
}
