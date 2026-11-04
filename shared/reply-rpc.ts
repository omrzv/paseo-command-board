import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Saves images pasted into a reply as files on the daemon. A reply that joins
 * a running turn reaches Claude Code as text only, so the reply names the
 * files and the agent can open them.
 */
export const replySaveImagesRpc = defineRpc({
  name: "reply.save-images",
  input: z.object({ images: z.array(z.object({ data: z.string(), mimeType: z.string() })).max(8) }),
  output: z.object({ paths: z.array(z.string()) }),
});
