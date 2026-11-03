import React from "react";
import type { TextProps, TextStyle } from "react-native";
import { openLink } from "../../components/open-link";
import { TaskText as Text } from "../typography";

const URL = /https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?]/g;

/** The text split into plain runs and URLs, in order. */
export function linkParts(text: string): Array<{ text: string; url?: string }> {
  const parts: Array<{ text: string; url?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: match[0], url: match[0] });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Text whose URLs open in the browser when pressed, underlined in the link colour. */
export function LinkedText(props: TextProps & { text: string; linkColor: string; style?: TextStyle | TextStyle[] }) {
  const { text, linkColor, ...rest } = props;
  return (
    <Text {...rest}>
      {linkParts(text).map((part, index) =>
        part.url ? (
          <Text
            key={index}
            accessibilityRole="link"
            onPress={(event) => { event.stopPropagation?.(); openLink(part.url!); }}
            style={{ color: linkColor, textDecorationLine: "underline" }}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
