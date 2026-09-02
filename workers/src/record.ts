import { runRecordLoop } from "@/lib/record/loop";

export async function startRecordWorker(): Promise<void> {
  await runRecordLoop({ exitOnSignal: true });
}
