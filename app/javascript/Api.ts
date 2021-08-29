import useSWR from "swr";
import { mutate } from "swr";
import * as Rails from "@rails/ujs";
import dayjs from "dayjs";

import { useState } from "react";

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

async function request(
  path: string,
  method: string,
  query: object | null,
  payload: object | null
) {
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
      err = new ApiError(
        new Error(`${path} returned error ${resp.status}`),
        await resp.json()
      );
    } else {
      const text = (await resp.text()).slice(0, 280);
      err = new ApiError(
        new Error(`${path} returned error ${resp.status}: ${text}`),
        null
      );
    }
    console.error(err.localError, err.remoteError);
    throw err;
  }
  return resp;
}

async function swrFetcher(url: string) {
  return (await request(url, "GET", null, null)).json();
}

export interface Attendee {
  name: string;
  avatar_url: string;
  is_ready: boolean;
  is_staff: boolean;
  is_speaker: boolean;
  is_committer: boolean;
  is_sponsor: boolean;
}

export interface Conference {
  default_track: string;
  track_order: string[];
  tracks: { [key: string]: Track };
}

export interface Track {
  slug: string;
  name: string;
  topic: Topic | null;
  speaker: Speaker | null;
  interpretation: boolean;
  // TODO: card: TrackCard | null;
}

export interface Topic {
  title: string | null;
  author: string | null;
  description: string | null;
  labels: string[];
  interpretation: boolean;
}

export interface Speaker {
  name: string;
  github_id: string | null;
  twitter_id: string | null;
  avatar_url: string;
}

export interface TrackStreamOptions {
  interpretation: boolean;
  caption: boolean;
}

export type TrackStreamOptionsState = [
  TrackStreamOptions,
  (x: TrackStreamOptions) => void
];

export interface StreamInfo {
  slug: string;
  type: string;
  url: string;
  expiry: number;
}

export interface GetSessionResponse {
  attendee: Attendee | null;
}

export interface GetConferenceResponse {
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

export const Api = {
  useSession() {
    return useSWR<GetSessionResponse, ApiError>("/api/session", swrFetcher, {
      revalidateOnFocus: false,
    });
  },

  useConference() {
    return useSWR<GetConferenceResponse, ApiError>(
      "/api/conference",
      swrFetcher
    );
  },

  // XXX: this is not an API
  useTrackStreamOptions(): TrackStreamOptionsState {
    const browserStateKey = "rk-takeout-app--TrackStreamOption";
    let options: TrackStreamOptions = { interpretation: false, caption: false };

    const browserState = window.localStorage.getItem(browserStateKey);
    if (browserState) {
      try {
        options = JSON.parse(browserState);
      } catch (e) {
        console.warn(e);
      }
    } else {
      const acceptJapanese =
        navigator.languages
          .map((v) => v.match(/^ja($|-)/) !== null)
          .indexOf(true) !== -1;
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

  async createSession(
    email: string,
    reference: string
  ): Promise<CreateSessionResponse> {
    const resp = await request("/api/session", "POST", null, {
      email,
      reference,
    });
    mutate("/api/session");
    return resp.json();
  },

  async updateAttendee(
    name: string,
    gravatar_email: string
  ): Promise<UpdateAttendeeResponse> {
    const resp = await request("/api/attendee", "PUT", null, {
      name,
      gravatar_email,
    });
    mutate("/api/session");
    return resp.json();
  },

  useStream(slug: string, interpretation: boolean) {
    return useSWR<GetStreamResponse, ApiError>(
      `/api/streams/${slug}?interpretation=${interpretation ? "1" : "0"}`,
      swrFetcher,
      {
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        compare(knownData, newData) {
          // Accept new data only if expired
          if (!knownData || !newData) return false;
          const now = dayjs().unix() + 180;

          return !(
            knownData.stream.expiry < newData.stream.expiry &&
            knownData.stream.expiry <= now
          );
        },
      }
    );
  },
};

export default Api;
