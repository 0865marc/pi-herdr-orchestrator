import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "@juicesharp/rpiv-ask-user-question";

export default function registerAskUserQuestion(pi: ExtensionAPI) {
  askUserQuestion(pi);
}
