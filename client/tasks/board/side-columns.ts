/** A side column's width (Slack, My tasks, Keys): a share of the window, within its bounds. Never from the lanes, which get what these leave. */
export function sideColumnWidth(windowWidth: number, share: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(windowWidth * share)));
}
