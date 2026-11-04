import type { PaseoApi } from "@getpaseo/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useRef } from "react";
import { replySaveImagesRpc } from "../../../shared/reply-rpc";
import type { ReplyImage } from "../cards/detail-cards";
import type { TaskCard } from "../model";

/** The reply's text with the saved images named, so an agent that only gets the text can still open them. */
export function withImagePaths(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const lines = paths.map((path) => `[Pasted image: ${path}]`);
  return `${text}\n\n${lines.join("\n")}`;
}

/**
 * Replying to an agent and answering its question from the board.
 * Images go both ways: attached, and saved as files named in the text. A
 * reply that joins a running turn reaches Claude Code as text only, which
 * dropped the attached images.
 */
export function useAgentReply(paseo: PaseoApi) {
  const saveNow = useRpc(replySaveImagesRpc);
  const save = useRef(saveNow);
  save.current = saveNow;

  const reply = useCallback(async (card: TaskCard, text: string, images: ReplyImage[]) => {
    let message = text;
    if (images.length > 0) {
      try {
        message = withImagePaths(text, (await save.current({ images })).paths);
      } catch {
        // The attached images still go.
      }
    }
    await paseo.agents.ref(card.id).send(message, { ...(images.length ? { images } : {}), activeTurnBehavior: "steer" });
  }, [paseo]);

  const answer = useCallback(async (card: TaskCard, answers: Record<string, string> | null) => {
    const requestId = card.permission?.requestId;
    if (!requestId) throw new Error("This question was already answered.");
    await paseo.agents.ref(card.id).respondToPermission({
      requestId,
      response: answers ? { behavior: "allow", updatedInput: { answers } } : { behavior: "deny", message: "Dismissed by user" },
    });
  }, [paseo]);

  return useMemo(() => ({ reply, answer }), [reply, answer]);
}
