import { Credential } from "@prisma/client";
import async from "async";
import merge from "lodash/merge";
import { v5 as uuidv5 } from "uuid";

import { AdditionInformation, CalendarEvent, createEvent, updateEvent } from "@lib/calendarClient";
import { FAKE_DAILY_CREDENTIAL } from "@lib/integrations/Daily/DailyVideoApiAdapter";
import { LocationType } from "@lib/location";
import prisma from "@lib/prisma";
import { Ensure } from "@lib/types/utils";
import { createMeeting, updateMeeting, VideoCallData } from "@lib/videoClient";

export type Event = AdditionInformation & VideoCallData;

export interface EventResult {
  type: string;
  success: boolean;
  uid: string;
  createdEvent?: Event;
  updatedEvent?: Event;
  originalEvent: CalendarEvent;
}

export interface CreateUpdateResult {
  results: Array<EventResult>;
  referencesToCreate: Array<PartialReference>;
}

export interface PartialBooking {
  id: number;
  references: Array<PartialReference>;
}

export interface PartialReference {
  id?: number;
  type: string;
  uid: string;
  meetingId?: string | null;
  meetingPassword?: string | null;
  meetingUrl?: string | null;
}

export const isZoom = (location: string): boolean => {
  return location === "integrations:zoom";
};

export const isDaily = (location: string): boolean => {
  return location === "integrations:daily";
};

export const isDedicatedIntegration = (location: string): boolean => {
  return isZoom(location) || isDaily(location);
};

export const getLocationRequestFromIntegration = (location: string) => {
  if (
    location === LocationType.GoogleMeet.valueOf() ||
    location === LocationType.Zoom.valueOf() ||
    location === LocationType.Daily.valueOf()
  ) {
    const requestId = uuidv5(location, uuidv5.URL);

    return {
      conferenceData: {
        createRequest: {
          requestId: requestId,
        },
      },
      location,
    };
  }

  return null;
};

export const processLocation = (event: CalendarEvent): CalendarEvent => {
  // If location is set to an integration location
  // Build proper transforms for evt object
  // Extend evt object with those transformations
  if (event.location?.includes("integration")) {
    const maybeLocationRequestObject = getLocationRequestFromIntegration(event.location);

    event = merge(event, maybeLocationRequestObject);
  }

  return event;
};

export default class EventManager {
  calendarCredentials: Array<Credential>;
  videoCredentials: Array<Credential>;

  /**
   * Takes an array of credentials and initializes a new instance of the EventManager.
   *
   * @param credentials
   */
  constructor(credentials: Array<Credential>) {
    this.calendarCredentials = credentials.filter((cred) => cred.type.endsWith("_calendar"));
    this.videoCredentials = credentials.filter((cred) => cred.type.endsWith("_video"));

    //for  Daily.co video, temporarily pushes a credential for the daily-video-client
    const hasDailyIntegration = process.env.DAILY_API_KEY;
    if (hasDailyIntegration) {
      this.videoCredentials.push(FAKE_DAILY_CREDENTIAL);
    }
  }

  /**
   * Takes a CalendarEvent and creates all necessary integration entries for it.
   * When a video integration is chosen as the event's location, a video integration
   * event will be scheduled for it as well.
   *
   * @param event
   */
  public async create(event: Ensure<CalendarEvent, "language">): Promise<CreateUpdateResult> {
    const evt = processLocation(event);
    const isDedicated = evt.location ? isDedicatedIntegration(evt.location) : null;

    const results: Array<EventResult> = [];
    // If and only if event type is a dedicated meeting, create a dedicated video meeting.
    if (isDedicated) {
      const result = await this.createVideoEvent(evt);
      if (result.createdEvent) {
        evt.videoCallData = result.createdEvent;
        evt.location = result.createdEvent.url;
      }

      results.push(result);
    }

    // Create the calendar event with the proper video call data
    results.push(...(await this.createAllCalendarEvents(evt)));

    const referencesToCreate: Array<PartialReference> = results.map((result: EventResult) => {
      return {
        type: result.type,
        uid: result.createdEvent?.id.toString() ?? "",
        meetingId: result.createdEvent?.id.toString(),
        meetingPassword: result.createdEvent?.password,
        meetingUrl: result.createdEvent?.url,
      };
    });

    return {
      results,
      referencesToCreate,
    };
  }

  /**
   * Takes a calendarEvent and a rescheduleUid and updates the event that has the
   * given uid using the data delivered in the given CalendarEvent.
   *
   * @param event
   */
  public async update(
    event: Ensure<CalendarEvent, "language">,
    rescheduleUid: string
  ): Promise<CreateUpdateResult> {
    const evt = processLocation(event);

    if (!rescheduleUid) {
      throw new Error("You called eventManager.update without an `rescheduleUid`. This should never happen.");
    }

    // Get details of existing booking.
    const booking = await prisma.booking.findFirst({
      where: {
        uid: rescheduleUid,
      },
      select: {
        id: true,
        references: {
          select: {
            id: true,
            type: true,
            uid: true,
            meetingId: true,
            meetingPassword: true,
            meetingUrl: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error("booking not found");
    }

    const isDedicated = evt.location ? isDedicatedIntegration(evt.location) : null;
    const results: Array<EventResult> = [];
    // If and only if event type is a dedicated meeting, update the dedicated video meeting.
    if (isDedicated) {
      const result = await this.updateVideoEvent(evt, booking);
      if (result.updatedEvent) {
        evt.videoCallData = result.updatedEvent;
        evt.location = result.updatedEvent.url;
      }
      results.push(result);
    }

    // Update all calendar events.
    results.push(...(await this.updateAllCalendarEvents(evt, booking)));

    // Now we can delete the old booking and its references.
    const bookingReferenceDeletes = prisma.bookingReference.deleteMany({
      where: {
        bookingId: booking.id,
      },
    });
    const attendeeDeletes = prisma.attendee.deleteMany({
      where: {
        bookingId: booking.id,
      },
    });

    const bookingDeletes = prisma.booking.delete({
      where: {
        id: booking.id,
      },
    });

    // Wait for all deletions to be applied.
    await Promise.all([bookingReferenceDeletes, attendeeDeletes, bookingDeletes]);

    return {
      results,
      referencesToCreate: [...booking.references],
    };
  }

  /**
   * Creates event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * When the optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @param noMail
   * @private
   */

  private async createAllCalendarEvents(event: CalendarEvent): Promise<Array<EventResult>> {
    const [firstCalendar] = this.calendarCredentials;
    if (!firstCalendar) {
      return [];
    }
    return [await createEvent(firstCalendar, event)];
  }

  /**
   * Checks which video integration is needed for the event's location and returns
   * credentials for that - if existing.
   * @param event
   * @private
   */

  private getVideoCredential(event: CalendarEvent): Credential | undefined {
    if (!event.location) {
      return undefined;
    }

    const integrationName = event.location.replace("integrations:", "");

    return this.videoCredentials.find((credential: Credential) => credential.type.includes(integrationName));
  }

  /**
   * Creates a video event entry for the selected integration location.
   *
   * When optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @private
   */
  private createVideoEvent(event: Ensure<CalendarEvent, "language">): Promise<EventResult> {
    const credential = this.getVideoCredential(event);

    if (credential) {
      return createMeeting(credential, event);
    } else {
      return Promise.reject("No suitable credentials given for the requested integration name.");
    }
  }

  /**
   * Updates the event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * @param event
   * @param booking
   * @private
   */
  private updateAllCalendarEvents(
    event: CalendarEvent,
    booking: PartialBooking
  ): Promise<Array<EventResult>> {
    return async.mapLimit(this.calendarCredentials, 5, async (credential: Credential) => {
      const bookingRefUid = booking
        ? booking.references.filter((ref) => ref.type === credential.type)[0]?.uid
        : null;

      return updateEvent(credential, event, bookingRefUid);
    });
  }

  /**
   * Updates a single video event.
   *
   * @param event
   * @param booking
   * @private
   */
  private updateVideoEvent(event: CalendarEvent, booking: PartialBooking) {
    const credential = this.getVideoCredential(event);

    if (credential) {
      const bookingRef = booking ? booking.references.filter((ref) => ref.type === credential.type)[0] : null;
      return updateMeeting(credential, event, bookingRef);
    } else {
      return Promise.reject("No suitable credentials given for the requested integration name.");
    }
  }
}
