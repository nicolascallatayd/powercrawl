import Anthropic from "@anthropic-ai/sdk";

export function createClient() {
  return new Anthropic();
}
