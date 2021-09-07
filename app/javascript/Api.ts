import useSWR from "swr";
import { mutate } from "swr";
import * as Rails from "@rails/ujs";
import dayjs from "dayjs";

import { CHAT_CACHE_KEY } from "./meta";

import { useState, useEffect } from "react";

export class ApiError extends Error {
  public localError: Error;
  public remoteError: object | null;

  constructor(localError: Error, remoteError: object | null, ...params: any[]) {
    super(...params);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
    const j = JSON.stringify(remoteError);
    this.name = localError.name;
    this.message = `${localError.message}, ${j}`;
    this.localError = localError;
    this.remoteError = remoteError;
  }
}

export async function request(path: string, method: string, query: object | null, payload: object | null) {
  let url = path;

  const headers = new Headers();
  const opts: RequestInit = {
    method: method,
    headers: headers,
    credentials: "include",
  };
  if (query) {
    const queryParams = [];
    for (const [k, v] of Object.entries(query)) {
      const snakeK = k.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
      queryParams.push(`${snakeK}=${encodeURIComponent(v as string)}`);
    }
    url += `?${queryParams.join("&")}`;
  }

  headers.append("X-Csrf-Token", Rails.csrfToken() || "");
  headers.append("Accept", "application/json");
  if (payload) {
    opts.body = JSON.stringify(payload);
    headers.append("Content-Type", "application/json");
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const contentType = resp.headers.get("Content-Type");

    let err;
    if (contentType && contentType.match(/^application\/json(;.+)?$/)) {
      err = new ApiError(new Error(`${path} returned error ${resp.status}`), await resp.json());
    } else {
      const text = (await resp.text()).slice(0, 280);
      err = new ApiError(new Error(`${path} returned error ${resp.status}: ${text}`), null);
    }
    console.error(err.localError, err.remoteError);
    throw err;
  }
  return resp;
}

function determineConferenceDataUpdatedAt(data: GetConferenceResponse) {
  const timestamps = data.conference.track_order.map((slug) => data.conference.tracks[slug]?.card?.at || 0);
  return Math.max(...timestamps);
}

function determineEarliestCandidateActivationAt(data: GetConferenceResponse) {
  const timestamps = data.conference.track_order
    .map((slug) => data.conference.tracks[slug]?.card_candidate?.at)
    .filter((v): v is number => !!v);
  if (timestamps.length < 1) return undefined;
  const at = Math.min(...timestamps);
  if (at == Infinity || at == NaN) return undefined;
  return at;
}

export function consumeIvsMetadata(metadata: IvsMetadata) {
  mutate(
    "/api/conference",
    (known: GetConferenceResponse) => {
      let updated = false;
      metadata.i?.forEach((item) => {
        if (item.c) {
          const cardUpdate = item.c;
          const card_key = cardUpdate.candidate ? "card_candidate" : "card";

          if (cardUpdate.clear) {
            const track = known.conference.tracks[cardUpdate.clear];
            if (track?.[card_key]) {
              console.log("Clearing card", { key: card_key, cardUpdate });
              track[card_key] = null;
              updated = true;
            }
          } else if (cardUpdate.card) {
            const track = known.conference.tracks[cardUpdate.card.track];
            if (track) {
              console.log("Updating card", { key: card_key, cardUpdate });
              track[card_key] = cardUpdate.card;
              updated = true;
            }
          }
        }

        if (item.p) {
          const presence = item.p;
          const track = known.conference.tracks[presence.track];
          const was = track.presences[presence.kind];
          track.presences[presence.kind] = presence.online;
          if (was !== presence.online) {
            console.log("Updating stream presence", presence);
            updated = true;
          }
        }
      });
      if (updated) known.requested_at = 0;
      return { ...known }; // NOTE: returning the same reference doesn't update cache
    },
    false,
  );
}

export function consumeChatAdminControl(adminControl: ChatAdminControl) {
  if (adminControl.pin) {
    mutate(
      `/api/tracks/${encodeURIComponent(adminControl.pin.track)}/chat_message_pin`,
      { track: adminControl.pin.track, pin: adminControl.pin },
      false,
    );
  }
  if (adminControl.spotlights) {
    const spotlights = adminControl.spotlights;
    mutate(
      "/api/conference",
      (known: GetConferenceResponse) => {
        spotlights.forEach((spotlight) => {
          const track = known.conference.tracks[spotlight.track];
          if (!track) return;
          const idx = track.spotlights.findIndex((v) => v.id === spotlight.id);
          if (idx !== -1) {
            track.spotlights[idx] = spotlight;
          } else {
            track.spotlights.push(spotlight);
          }
        });
        return { ...known };
      },
      false,
    );
  }
  if (adminControl.presences) {
    const presences = adminControl.presences;
    mutate(
      "/api/conference",
      (known: GetConferenceResponse) => {
        presences.forEach((presence) => {
          const track = known.conference.tracks[presence.track];
          const was = track.presences[presence.kind];
          track.presences[presence.kind] = presence.online;
          if (was !== presence.online) {
            console.log("Updating stream presence (chat)", presence);
          }
        });
      },
      false,
    );
  }
}

function activateCandidateTrackCard(data: GetConferenceResponse) {
  console.log("Start activating candidate TrackCard");
  const now = dayjs().unix();
  let updated = false;
  for (const [, track] of Object.entries(data.conference.tracks)) {
    const candidate = track.card_candidate;
    if (!candidate) continue;
    if (now >= candidate.at) {
      console.log(`Activating candidate TrackCard for track=${track.slug}`, track.card_candidate);
      updated = true;
      track.card = candidate;
      track.card_candidate = null;
    } else {
      console.log(`Skipping candidate activation for track=${track.slug}`, track.card_candidate);
    }
  }
  if (updated) {
    console.log("Mutating /api/conference due to candidate TrackCard activation");
    mutate("/api/conference", { ...data }, false);
  }
}

export async function swrFetcher(url: string) {
  return (await request(url, "GET", null, null)).json();
}

export interface Attendee {
  id: number;
  name: string;
  avatar_url: string;
  is_ready: boolean;
  is_staff: boolean;
  is_speaker: boolean;
  is_committer: boolean;

  is_sponsor?: boolean;
  presentation_slugs?: string[];
}

export interface Conference {
  default_track: string;
  track_order: TrackSlug[];
  tracks: { [key: string]: Track };
}

export type TrackSlug = string;

export interface Track {
  slug: TrackSlug;
  name: string;
  interpretation: boolean;
  chat: boolean;
  card: TrackCard | null;
  card_candidate: TrackCard | null;
  spotlights: ChatSpotlight[];
  presences: { [key: string]: boolean };
}

export interface TrackCard extends TrackCardHeader, TrackCardContent {}

export interface TrackCardHeader {
  track: TrackSlug;
  at: number;
}
export interface TrackCardContent {
  interpretation: boolean;
  topic: Topic | null;
  speakers: Speaker[] | null;
}

export interface Topic {
  title: string | null;
  author: string | null;
  description: string | null;
  labels: string[];
}

export interface Speaker {
  name: string;
  github_id: string | null;
  twitter_id: string | null;
  avatar_url: string;
}

export interface ChatSpotlight {
  id: number;
  track: TrackSlug;
  starts_at: number;
  ends_at: number;
  handles: ChatHandle[];
}

export interface TrackStreamOptions {
  interpretation: boolean;
  caption: boolean;
  chat: boolean;
}

export type TrackStreamOptionsState = [TrackStreamOptions, (x: TrackStreamOptions) => void];

export interface StreamInfo {
  slug: TrackSlug;
  type: string;
  url: string;
  expiry: number;
}

export type ChannelArn = string;

export interface TrackChatInfo {
  channel_arn: ChannelArn;
  caption_channel_arn?: ChannelArn;
}

export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
}

export interface GetSessionResponse {
  attendee: Attendee | null;
  control: boolean;
}
export type ChatSessionTracksBag = { [key: string]: TrackChatInfo | null };

export interface GetChatSessionResponse {
  expiry: number;
  grace: number;
  app_arn: string;
  user_arn: string;
  app_user_arn: string;
  aws_credentials: AwsCredentials;
  tracks: ChatSessionTracksBag;
}

export interface GetConferenceResponse {
  requested_at: number;
  stale_after: number;
  conference: Conference;
}

export interface CreateSessionResponse {
  attendee: Attendee;
}

export interface UpdateAttendeeResponse {
  attendee: Attendee;
}

export interface GetStreamResponse {
  stream: StreamInfo;
}

export interface GetChatMessagePinResponse {
  track: TrackSlug;
  pin: ChatMessagePin | null;
}

export interface ChatMessage {
  channel: ChannelArn;
  content: string | null;
  sender: ChatSender;
  timestamp: number; // millis
  id: string;
  redacted: boolean;

  adminControl: ChatAdminControl | null;
}

export interface ChatAdminControl {
  flush?: boolean;
  pin?: ChatMessagePin;
  caption?: ChatCaption;
  spotlights?: ChatSpotlight[];
  presences?: StreamPresence[];
}

export interface ChatCaption {
  result_id: string;
  is_partial: boolean;
  transcript: string;
}

// XXX: Determined and given at ChatSession
export interface ChatSenderFlags {
  isAdmin?: boolean;
  isAnonymous?: boolean;
  isStaff?: boolean;
  isSpeaker?: boolean;
  isCommitter?: boolean;
}

export type ChatHandle = string;

export interface ChatSender extends ChatSenderFlags {
  handle: ChatHandle;
  name: string;
  version: string;
}

export interface ChatMessagePin {
  at: number;
  track: TrackSlug;
  message: ChatMessage | null;
}

export interface IvsMetadata {
  i: IvsMetadataItem[];
}
export interface IvsMetadataItem {
  c?: IvsCardUpdate;
  p?: StreamPresence;
}

export interface IvsCardUpdate {
  candidate?: boolean;
  clear?: TrackSlug;
  card: TrackCard | null;
}

export interface StreamPresence {
  track: TrackSlug;
  kind: "main" | "interpretation";
  online: boolean;
}

export const Api = {
  useSession() {
    return useSWR<GetSessionResponse, ApiError>("/api/session", swrFetcher, {
      revalidateOnFocus: false,
    });
  },

  useConference() {
    // TODO: Error handling
    const swr = useSWR<GetConferenceResponse, ApiError>("/api/conference", swrFetcher, {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      //focusThrottleInterval: 15 * 1000, // TODO:
      compare(knownData, newData) {
        if (!knownData || !newData) return false;
        const knownTimestamp = determineConferenceDataUpdatedAt(knownData);
        const newTimestamp = determineConferenceDataUpdatedAt(newData);
        return knownTimestamp > newTimestamp;
      },
    });

    // Schedule candidate TrackCard activation
    const { data } = swr;
    useEffect(() => {
      if (!data) return;
      const earliestCandidateActivationAt = determineEarliestCandidateActivationAt(data);
      if (!earliestCandidateActivationAt) return;
      const timeout = (earliestCandidateActivationAt - dayjs().unix()) * 1000 + 500;
      console.log(
        `Scheduling candidate TrackCard activation; earliest will happen at ${dayjs(
          new Date(earliestCandidateActivationAt * 1000),
        ).toISOString()}, in ${timeout / 1000}s`,
      );

      const timer = setTimeout(() => activateCandidateTrackCard(data), timeout);
      return () => clearTimeout(timer);
    }, [data]);

    return swr;
  },

  // XXX: this is not an API
  useTrackStreamOptions(): TrackStreamOptionsState {
    const browserStateKey = "rk-takeout-app--TrackStreamOption";
    let options: TrackStreamOptions = { interpretation: false, caption: false, chat: true };

    const browserState = window.localStorage.getItem(browserStateKey);
    if (browserState) {
      try {
        options = JSON.parse(browserState);
      } catch (e) {
        console.warn(e);
      }
      if (!options.hasOwnProperty("chat")) {
        options.chat = true;
      }
    } else {
      const acceptJapanese = navigator.languages.map((v) => v.match(/^ja($|-)/) !== null).indexOf(true) !== -1;
      options.interpretation = !acceptJapanese;
    }

    const [state, setState] = useState(options);

    return [
      state,
      (x: TrackStreamOptions) => {
        window.localStorage.setItem(browserStateKey, JSON.stringify(x));
        setState(x);
      },
    ];
  },

  async createSession(email: string, reference: string): Promise<CreateSessionResponse> {
    const resp = await request("/api/session", "POST", null, {
      email,
      reference,
    });
    mutate("/api/session");
    return resp.json();
  },

  async updateAttendee(name: string, gravatar_email: string): Promise<UpdateAttendeeResponse> {
    const resp = await request("/api/attendee", "PUT", null, {
      name,
      gravatar_email,
    });
    mutate("/api/session");
    return resp.json();
  },

  useStream(slug: TrackSlug, interpretation: boolean) {
    return useSWR<GetStreamResponse, ApiError>(
      `/api/streams/${slug}?interpretation=${interpretation ? "1" : "0"}`,
      swrFetcher,
      {
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        focusThrottleInterval: 60 * 15 * 1000,
        compare(knownData, newData) {
          // Accept new data only if expired
          if (!knownData || !newData) return false;
          const now = dayjs().unix() + 180;

          return !(knownData.stream.expiry < newData.stream.expiry && knownData.stream.expiry <= now);
        },
      },
    );
  },

  useChatSession(attendeeId: number | undefined) {
    // attendeeId for cache buster
    return useSWR<GetChatSessionResponse, ApiError>(
      attendeeId ? `/api/chat_session?i=${attendeeId}&p=${CHAT_CACHE_KEY}` : null,
      swrFetcher,
      {
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        focusThrottleInterval: 60 * 40 * 1000,
        refreshInterval: 60 * 80 * 1000,
        refreshWhenHidden: false,
        refreshWhenOffline: false,
      },
    );
  },

  useChatMessagePin(track: TrackSlug | undefined) {
    return useSWR<GetChatMessagePinResponse, ApiError>(
      track ? `/api/tracks/${encodeURIComponent(track)}/chat_message_pin` : null,
      swrFetcher,
      {
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        focusThrottleInterval: 60 * 1000,
      },
    );
  },

  async sendChatMessage(track: TrackSlug, message: string, asAdmin?: boolean) {
    const resp = await request(`/api/tracks/${encodeURIComponent(track)}/chat_messages`, "POST", null, {
      message,
      as_admin: !!asAdmin,
    });
    return resp.json();
  },

  async pinChatMessage(track: TrackSlug, chatMessage: ChatMessage | null) {
    const resp = await request(`/api/tracks/${encodeURIComponent(track)}/chat_admin_message_pin`, "PUT", null, {
      chat_message: chatMessage,
    });
    return resp.json();
  },

  async createCaptionChatMembership(track: TrackSlug) {
    const resp = await request(`/api/tracks/${encodeURIComponent(track)}/caption_chat_membership`, "POST", null, {});
    return resp.json();
  },
};

export default Api;
