import type { TaskLocation } from "../model";

/**
 * Each workspace's own colour, so "omerziv", "omerziv › AI" and "omerziv › Fam"
 * read apart at a glance. The hue comes from a hash of the workspace (its id,
 * else its title, else the project), spread by the golden angle so
 * neighbouring hashes land far apart on the wheel. Saturation and lightness
 * are fixed per theme so the colour reads as text on the card.
 */
export function workspaceColor(location: Pick<TaskLocation, "workspaceId" | "workspaceTitle" | "projectKey" | "projectId" | "projectName">, isDark: boolean): string | null {
  const key = location.workspaceId ?? location.workspaceTitle ?? location.projectKey ?? location.projectId ?? location.projectName;
  if (!key) return null;
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const hue = (hash * 137.508) % 360;
  return hslHex(hue, isDark ? 62 : 58, isDark ? 66 : 42);
}

function hslHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
