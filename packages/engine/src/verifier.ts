export interface TrackFeatures {
  /** BPM, or null when the source has no data for it. */
  tempo: number | null;
  /** From 0 to 1, higher for more spoken words, or null when the source has no data for it. */
  speechiness: number | null;
}

export interface TempoVerifier {
  featuresOf(spotifyTrackId: string): Promise<TrackFeatures>;
  /** Like featuresOf for each track, in order, with one request for the tracks not yet cached. */
  featuresOfAll(spotifyTrackIds: string[]): Promise<TrackFeatures[]>;
  /** Spotify popularity from 0 to 100 for each track, in order, null where the source has none. */
  popularityOf(spotifyTrackIds: string[]): Promise<(number | null)[]>;
}
