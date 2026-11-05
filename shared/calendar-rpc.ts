import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const meetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Epoch ms. */
  start: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  location: z.string(),
  description: z.string(),
  joinUrl: z.string().nullable(),
  organizer: z.string(),
  attendees: z.array(z.object({ name: z.string(), email: z.string(), status: z.string() })),
  /** Your own answer: accepted, tentative, needs-action, or empty when you organise it. */
  myStatus: z.string(),
});
export type Meeting = z.output<typeof meetingSchema>;

export const calendarStatusSchema = z.object({
  connected: z.boolean(),
  /** The calendar's name, usually your email. */
  name: z.string(),
  fetchedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type CalendarStatus = z.output<typeof calendarStatusSchema>;

/** Today's and tomorrow's meetings, declined ones left out. */
export const calendarTodayRpc = defineRpc({
  name: "calendar.today",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({ status: calendarStatusSchema, meetings: z.array(meetingSchema) }),
});

/** Saves the calendar's private iCal address (in the Keychain, as a key) after reading it once. */
export const calendarConnectRpc = defineRpc({
  name: "calendar.connect",
  input: z.object({ url: z.string().min(10).max(2000) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const calendarDisconnectRpc = defineRpc({
  name: "calendar.disconnect",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
