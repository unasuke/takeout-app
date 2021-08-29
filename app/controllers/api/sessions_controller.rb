require 'digest/md5'

class Api::SessionsController < Api::ApplicationController
  before_action :require_attendee, only: %i(destroy)

  def show
    render(json: {
      attendee: current_attendee&.as_json,
    }.to_json)
  end

  def create
    ticket = Ticket.find_by(reference: params[:reference]&.strip, email: params[:email]&.strip, state: 'complete')
    unless ticket
      raise Api::ApplicationController::Error::Unauthorized, "Ticket not found. Check your entered information is identical to the one shown on your ticket."
    end

    attendee = ticket.active_attendee
    unless attendee
      attendee = ticket.attendees.build(
        name: "#{ticket.first_name} #{ticket.last_name}",
        gravatar_email: ticket.email,
        ready: false,
      )
      attendee.assign_inferred_role
      attendee.save!
    end

    if Rails.application.config.x.staff_only
      unless attendee.staff?
        raise Api::ApplicationController::Error::Forbidden, "currently in staff only mode"
      end
    end

    CreateChimeUserJob.perform_later(attendee)

    session[:attendee_id] = attendee.id
    render(json: {ok: true, attendee: attendee.as_json}.to_json)
  end

  def destroy
    session[:attendee_id] = nil
    render(json: {ok: true}.to_json)
  end
end
