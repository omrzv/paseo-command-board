import { describe, expect, it } from "vitest";
import { createCalendar, meetingsBetween, plainDescription, todayWindow } from "../../server/calendar";

const TZ = `BEGIN:VTIMEZONE
TZID:Asia/Jerusalem
BEGIN:STANDARD
TZOFFSETFROM:+0300
TZOFFSETTO:+0200
TZNAME:IST
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
TZOFFSETFROM:+0200
TZOFFSETTO:+0300
TZNAME:IDT
DTSTART:19700327T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1FR
END:DAYLIGHT
END:VTIMEZONE`;

const ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
X-WR-CALNAME:omer@hero.ai
${TZ}
BEGIN:VEVENT
DTSTART;TZID=Asia/Jerusalem:20261001T100000
DTEND;TZID=Asia/Jerusalem:20261001T103000
RRULE:FREQ=WEEKLY;BYDAY=TH
EXDATE;TZID=Asia/Jerusalem:20261112T100000
UID:weekly-1
SUMMARY:1:1 Dana
ORGANIZER;CN=Omer:mailto:omer@hero.ai
ATTENDEE;CN=Dana Levi;PARTSTAT=ACCEPTED:mailto:dana@hero.ai
ATTENDEE;CN=Omer;PARTSTAT=ACCEPTED:mailto:omer@hero.ai
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
DESCRIPTION:Agenda<br>- survey&nbsp;results
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Jerusalem:20261119T140000
DTEND;TZID=Asia/Jerusalem:20261119T143000
RECURRENCE-ID;TZID=Asia/Jerusalem:20261119T100000
UID:weekly-1
SUMMARY:1:1 Dana (moved)
END:VEVENT
BEGIN:VEVENT
DTSTART:20261105T120000Z
DTEND:20261105T130000Z
UID:declined-1
SUMMARY:All hands
ATTENDEE;CN=Omer;PARTSTAT=DECLINED:mailto:omer@hero.ai
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106
UID:allday-1
SUMMARY:Conference
LOCATION:Join https://us02web.zoom.us/j/123456789?pwd=x
END:VEVENT
END:VCALENDAR`;

const at = (iso: string) => Date.parse(iso);

describe("calendar", () => {
  it("expands recurring meetings in their time zone, with moved and cancelled ones, and leaves out declined", () => {
    const thursday = meetingsBetween(ICS, at("2026-11-04T22:00:00Z"), at("2026-11-05T22:00:00Z"));
    expect(thursday.name).toBe("omer@hero.ai");
    expect(thursday.meetings.map((meeting) => meeting.title)).toEqual(["Conference", "1:1 Dana"]);
    const dana = thursday.meetings[1]!;
    expect(new Date(dana.start).toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(dana.joinUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(dana.attendees).toEqual([{ name: "Dana Levi", email: "dana@hero.ai", status: "accepted" }]);
    expect(dana.myStatus).toBe("accepted");
    expect(dana.description).toBe("Agenda\n- survey results");
    expect(thursday.meetings[0]).toMatchObject({ allDay: true, joinUrl: "https://us02web.zoom.us/j/123456789?pwd=x" });
    // The cancelled occurrence, and the moved one at its new time.
    expect(meetingsBetween(ICS, at("2026-11-11T22:00:00Z"), at("2026-11-12T22:00:00Z")).meetings).toEqual([]);
    const moved = meetingsBetween(ICS, at("2026-11-18T22:00:00Z"), at("2026-11-19T22:00:00Z")).meetings;
    expect(moved.map((meeting) => [meeting.title, new Date(meeting.start).toISOString()])).toEqual([["1:1 Dana (moved)", "2026-11-19T12:00:00.000Z"]]);
  });

  it("strips Google's footer and HTML from descriptions", () => {
    expect(plainDescription("Hi<br/>there\n-::~:~::~:~:~:~:~:~:~:~:~:~\nJoin with Google Meet\n-::~:~::~:~:~:~:~:~:~:~:~:~:~\nend")).toBe("Hi\nthere\nend");
  });

  it("keeps the address in the key store and reads the calendar from it", async () => {
    const saved: Array<{ envVar: string; value?: string }> = [];
    const keys = {
      list: async () => saved.map((key, index) => ({ id: String(index), envVar: key.envVar })),
      reveal: async (id: string) => saved[Number(id)]!.value!,
      save: async (input: { envVar: string; value?: string }) => { saved.push(input); return input; },
      remove: async () => { saved.length = 0; return true; },
    };
    const fetched: string[] = [];
    const calendar = createCalendar({
      keys: keys as never,
      now: () => at("2026-11-05T07:00:00Z"),
      fetcher: async (url) => { fetched.push(url); return { ok: !url.includes("bad"), status: url.includes("bad") ? 404 : 200, text: async () => ICS }; },
    });
    expect((await calendar.today()).status.connected).toBe(false);
    expect(await calendar.connect("webcal://calendar.google.com/bad/basic.ics")).toMatchObject({ ok: false, error: expect.stringMatching(/404/) });
    expect(await calendar.connect("webcal://calendar.google.com/x/basic.ics")).toEqual({ ok: true, error: null });
    expect(saved[0]).toMatchObject({ envVar: "GOOGLE_CALENDAR_ICS", value: "webcal://calendar.google.com/x/basic.ics" });
    expect(fetched.at(-1)).toBe("https://calendar.google.com/x/basic.ics");
    const today = await calendar.today();
    expect(today.status).toMatchObject({ connected: true, name: "omer@hero.ai", error: null });
    expect(today.meetings.map((meeting) => meeting.title)).toContain("1:1 Dana");
    expect(todayWindow(at("2026-11-05T07:00:00Z")).to - todayWindow(at("2026-11-05T07:00:00Z")).from).toBeGreaterThanOrEqual(47 * 3600_000);
  });
});
