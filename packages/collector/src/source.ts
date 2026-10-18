/** A song a provider lists at the BPM it was asked for. */
export interface SourceSong {
  title: string;
  artist: string;
  isrc?: string;
  durationS?: number;
  /** From 0 to 1, higher for better known songs. */
  popularity: number;
}
