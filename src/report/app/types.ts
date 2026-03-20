export interface RawRun {
  name: string
  rows: RawRow[]
}

export interface RawRow {
  timestamp: number
  event: string
  session_id: number
  worker_id: number
  iteration: number
  input_line_number: number
}

export interface RawRecording {
  duration: number
  events: Array<{ lineNumber: number; label: string }>
}

export interface RawData {
  runs: RawRun[]
  recording: RawRecording
}

export interface PairedEvent {
  session_id: number
  worker_id: number
  iteration: number
  input_line_number: number
  event_base: string
  start: number
  end: number
  time: number
  concurrency: number
  maintenance: boolean
}

export interface ProcessedRun {
  name: string
  paired: PairedEvent[]
}

export interface AppState {
  rawData: RawData
  runs: ProcessedRun[]
  currentRunIdx: number
  recordingDuration: number
  globalSessionsXDomain: [number, number]
  getRecordingLabel: (lineNum: number) => string
}
