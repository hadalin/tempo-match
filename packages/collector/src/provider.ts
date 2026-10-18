export interface TempoSong {
  title: string;
  artist: string;
  bpm: number;
  isrc?: string;
}

/** A source of songs by tempo. Implementations cache their own results per BPM. */
export interface SongProvider {
  songsAt(bpm: number): Promise<TempoSong[]>;
}
