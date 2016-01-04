(function() {

  'use_strict';

  return {
    SETUP_INFO: 'https://support.zendesk.com/entries/69791168-Setting-up-the-Time-Tracking-app',

    storage: {},

    requests: {
      fetchAuditsPage: function(url) {
        return {
          url: url || helpers.fmt(
            '/api/v2/tickets/%@/audits.json?include=users',
            this.ticket().id()
          )
        };
      },
      fetchTicketForms: function(url) {
        return {
          url: url || '/api/v2/ticket_forms.json'
        };
      }
    },

    events: {
      'app.created'             : 'onAppCreated',
      'app.activated'           : 'onAppActivated',
      'app.deactivated'         : 'onAppFocusOut',
      'app.willDestroy'         : 'onAppWillDestroy',
      'ticket.save'             : 'onTicketSave',
      'ticket.submit.done'      : 'onTicketSubmitDone',
      '*.changed'               : 'onAnyTicketFieldChanged',
      'ticket.updated'          : 'onTicketUpdated',
      'fetchAuditsPage.done'    : 'onFetchAuditsPageDone',
      'fetchAllAudits.done'     : 'onFetchAllAuditsDone',
      'click .pause'            : 'onPauseClicked',
      'click .play'             : 'onPlayClicked',
      'click .reset'            : 'onResetClicked',
      'click .modal-save'       : 'onModalSaveClicked',
      'shown .modal'            : 'onModalShown',
      'hidden .modal'           : 'onModalHidden',
      'click .expand-bar'       : 'onTimelogsClicked'
    },

    /*
     *
     *  EVENT CALLBACKS
     *
     */
    onAppCreated: function() {
      if (this.installationId()) {
        var totalTimeField = this.requirement('total_time_field'),
            timeLastUpdateField = this.requirement('time_last_update_field');
        this.storage.totalTimeFieldId = totalTimeField && totalTimeField.requirement_id;
        this.storage.timeFieldId = timeLastUpdateField && timeLastUpdateField.requirement_id;

        this.initialize();
      } else {
        _.defer(this.initialize.bind(this));
        this.storage.totalTimeFieldId = parseInt(this.setting('total_time_field_id'), 10);
        this.storage.timeFieldId = parseInt(this.setting('time_field_id'), 10);
      }
      if (this.setting('hide_from_agents') && this.currentUser().role() !== 'admin') {
        this.hide();
      }
    },

    onAppActivated: function(app) {
      if (!app.firstLoad) {
        this.onAppFocusIn();
      }
    },

    onAppWillDestroy: function() {
      clearInterval(this.timeLoopID);
    },

    onAppFocusOut: function() {
      if (this.setting('auto_pause_resume')) {
        this.autoPause();
      }
    },

    onAppFocusIn: function() {
      if (this.setting('auto_pause_resume') && !this.manuallyPaused) {
        this.autoResume();
      }
    },

    onAnyTicketFieldChanged: function() {
      _.defer(this.hideFields.bind(this));
    },

    onTicketSave: function() {
      if (this.setting('time_submission') && this.visible()) {
        return this.promise(function(done, fail) {
          this.saveHookPromiseDone = done;
          this.saveHookPromiseFail = fail;

          this.renderTimeModal();
        }.bind(this));
      } else {
        this.updateTime(this.elapsedTime());

        return true;
      }
    },

    onTicketSubmitDone: function() {
      this.resetElapsedTime();
      _.delay(this.getTimelogs.bind(this), 1000);
    },

    onTicketUpdated: function(updatedBy) {
      if (updatedBy.id() !== this.currentUser().id()) {
        this.getTimelogs();
      }
    },

    onFetchAllAuditsDone: function() {
      var status = "",
          timeDiff,
          isFollowUp = _.reduce(this.store('audits'), function(isFollowUp, audit) {
            return isFollowUp || (audit.via && audit.via.source && audit.via.source.rel === 'follow_up');
          }, false);

      if (isFollowUp) {
        var audits = this.store('audits'),
            isThisEvent = function(event) {
              return event.field_name == this.storage.totalTimeFieldId;
            };
        for (var i = 0; i < audits.length; i++) {
          var audit = audits[i],
              totalTimeEvent = _.find(audit.events, isThisEvent, this);

          if (totalTimeEvent) break;

          /* If we got to the last one without breaking out so far, we can reset it */
          if (i === audits.length - 1) {
            this.totalTime('0');
          }
        }
      }

      var timelogs = _.reduce(this.store('audits'), function(memo, audit) {
            var newStatus = _.find(audit.events, function(event) {
                  return event.field_name == 'status';
                }, this),
                auditEvent = _.find(audit.events, function(event) {
                  return event.field_name == this.storage.totalTimeFieldId;
                }, this);

            if (newStatus) {
              status = newStatus.value;
            }

            if (auditEvent) {
              if (!memo.length) {
                auditEvent.previous_value = 0;
              }
              timeDiff = auditEvent.value - (auditEvent.previous_value || 0);
              memo.push({
                time: this.TimeHelper.secondsToTimeString(parseInt(timeDiff, 10)),
                date: new Date(audit.created_at).toLocaleString(),
                status: status,
                localized_status: this.I18n.t(helpers.fmt('statuses.%@', status)),
                user: _.find(this.store('users'), function(user) {
                  return user.id === audit.author_id;
                })
              });
            }

            return memo;
          }, [], this);

      this.renderTimelogs(timelogs.reverse());
    },

    onPauseClicked: function(e) {
      var $el = this.$(e.currentTarget);

      $el.find('i').addClass('active');
      this.$('.play i').removeClass('active');

      this.manuallyPaused = this.paused = true;
    },

    onPlayClicked: function(e) {
      var $el = this.$(e.currentTarget);

      $el.find('i').addClass('active');
      this.$('.pause i').removeClass('active');

      this.manuallyPaused = this.paused = false;
    },

    onResetClicked: function() {
      this.resetElapsedTime();
    },

    onTimelogsClicked: function() {
      this.$('.timelogs-container').slideToggle();
      this.$('.expand-bar').toggleClass('expanded');
    },

    onModalSaveClicked: function() {
      var timeString = this.$('.modal-time').val();

      try {
        this.updateTime(this.TimeHelper.timeStringToSeconds(timeString, this.setting('simple_submission')));
        this.saveHookPromiseIsDone = true; // Flag that saveHookPromiseDone is gonna be called after hiding the modal
        this.$('.modal').modal('hide');
        this.saveHookPromiseDone();
      } catch (e) {
        if (e.message == 'bad_time_format') {
          services.notify(this.I18n.t('errors.bad_time_format'), 'error');
        } else {
          throw e;
        }
      }
    },

    onModalShown: function() {
      var timeout = 15,
          $timeout = this.$('span.modal-timer'),
          $modal = this.$('.modal');

      this.modalTimeoutID = setInterval(function() {
        timeout -= 1;

        $timeout.html(timeout);

        if (timeout === 0) {
          $modal.modal('hide');
        }
      }.bind(this), 1000);

      $modal.find('.modal-save').focus();
    },

    onModalHidden: function() {
      clearInterval(this.modalTimeoutID);

      if (!this.saveHookPromiseIsDone) {
        this.saveHookPromiseFail(this.I18n.t('errors.save_hook'));
      }
    },

    /*
     *
     * METHODS
     *
     */

    checkForms: (function() {
      var forms = [];

      function fetch(url) {
        this.ajax('fetchTicketForms', url).done(callback.bind(this));
      }

      function callback(data) {
        forms.push.apply(forms, data.ticket_forms);

        if (data.next_page) {
          fetch.call(this, data.next_page);
        } else {
          var requiredTicketFieldIds = [
                this.storage.timeFieldId,
                this.storage.totalTimeFieldId
              ];

          forms = _.filter(forms, function(form) {
            return form.active;
          });

          var valid = _.all(forms, function(form) {
            return _.intersection(form.ticket_field_ids, requiredTicketFieldIds).length === requiredTicketFieldIds.length;
          });

          if (!valid) {
            this.switchTo('setup_info', { link: this.SETUP_INFO });
            this.$('.expand-bar').remove();
            this.onAppWillDestroy();
          }
        }
      }

      return function() {
        if (!this.ticket().form().id()) { return; }

        fetch.call(this);
      };
    })(),

    initialize: function() {
      this.getTimelogs();
      this.hideFields();
      this.checkForms();

      this.timeLoopID = this.setTimeLoop();

      this.switchTo('main', {
        manualPauseResume: this.setting('manual_pause_resume'),
        displayReset: this.setting('reset'),
        displayTimelogs: this.isTimelogsEnabled()
      });
    },

    fetchAllAudits: function(url, data, callback) {
      this.store('audits', []);
      this.store('users', []);
      this.ajax('fetchAuditsPage');
    },

    onFetchAuditsPageDone: function(data) {
      this.store('audits', this.store('audits').concat(data.audits));
      this.store('users', this.store('users').concat(data.users));

      if (!data.next_page) {
        this.trigger('fetchAllAudits.done');
      } else {
        this.ajax('fetchAuditsPage', data.next_page);
      }
    },

    getTimelogs: function() {
      if (this.isTimelogsEnabled()) { this.fetchAllAudits(); }
    },

    updateMainView: function(time) {
      this.$('.live-timer').html(this.TimeHelper.secondsToTimeString(time));
      this.$('.live-totaltimer').html(this.TimeHelper.secondsToTimeString(
        this.totalTime() + time
      ));
    },

    renderTimelogs: function(timelogs) {
      this.$('.timelogs-container')
        .html(this.renderTemplate('timelogs', {
          timelogs: timelogs
        }));

      this.$('tr').tooltip({ placement: 'left', html: true });
    },

    hideFields: function() {
      _.each([this.timeFieldLabel(), this.totalTimeFieldLabel()], function(f) {
        var field = this.ticketFields(f);

        if (field && field.isVisible()) {
          field.hide();
        }
      }, this);
    },

    /*
     * TIME RELATED
     */

    elapsedTime: function(time) {
      if (typeof time !== "undefined") {
        this.realElapsedTime = time * 1000;
      }
      return (this.realElapsedTime / 1000) | 0;
    },

    setTimeLoop: function() {
      this.lastTick = new Date();
      this.elapsedTime(0);

      return setInterval(function() {
        var now = new Date();
        if (!this.paused) {
          this.realElapsedTime += now.valueOf() - this.lastTick.valueOf();

          this.updateMainView(this.elapsedTime());
        }
        this.lastTick = now;
      }.bind(this), 1000);
    },

    updateTime: function(time) {
      this.time(time);
      this.totalTime(this.totalTime() + time);
    },

    autoResume: function() {
      this.paused = false;
    },

    autoPause: function() {
      this.paused = true;
    },

    renderTimeModal: function() {
      if (this.setting('simple_submission')) {
        this.$('.modal-time').val(Math.floor(this.elapsedTime() / 60));
      } else {
        this.$('.modal-time').val(this.TimeHelper.secondsToTimeString(this.elapsedTime()));
      }
      this.$('.modal').modal('show');
    },

    resetElapsedTime: function() {
      this.elapsedTime(0);
      this.updateMainView(this.elapsedTime());
    },

    /*
     *
     * UTILS
     *
     */

    isTimelogsEnabled: function() {
      return this.ticket() && this.ticket().id() && this.setting('display_timelogs');
    },

    time: function(time) {
      return this.getOrSetField(this.timeFieldLabel(), time);
    },

    totalTime: function(time) {
      return this.getOrSetField(this.totalTimeFieldLabel(), time) || 0;
    },

    totalTimeFieldLabel: function() {
      return this.buildFieldLabel(this.storage.totalTimeFieldId);
    },

    timeFieldLabel: function() {
      return this.buildFieldLabel(this.storage.timeFieldId);
    },

    buildFieldLabel: function(id) {
      return helpers.fmt('custom_field_%@', id);
    },

    getOrSetField: function(fieldLabel, value) {
      if (typeof value !== "undefined") {
        return this.ticket().customField(fieldLabel, value);
      }

      return parseInt((this.ticket().customField(fieldLabel) || 0), 10);
    },

    TimeHelper: {
      secondsToTimeString: function(seconds) {
        var negative = seconds < 0,
            absValue = Math.abs(seconds),
            hours    = Math.floor(absValue / 3600),
            minutes  = Math.floor((absValue - (hours * 3600)) / 60),
            secs     = absValue - (hours * 3600) - (minutes * 60);

        var timeString = helpers.fmt('%@:%@:%@',
          this.addInsignificantZero(hours),
          this.addInsignificantZero(minutes),
          this.addInsignificantZero(secs)
        );

        return (negative ? '-' : '') + timeString;
      },

      simpleFormat: /^-?\d+$/,

      complexFormat: /^(\d{0,2}):(\d{0,2}):(\d{0,2})$/,

      timeStringToSeconds: function(timeString, simple) {
        var result;

        if (simple) {
          result = timeString.match(this.simpleFormat);

          if (!result) { throw { message: 'bad_time_format' }; }

          return parseInt(result[0], 10) * 60;
        } else {
          result = timeString.match(this.complexFormat);

          if (!result || result.length != 4) { throw { message: 'bad_time_format' }; }

          return this.parseIntWithDefault(result[1]) * 3600 +
            this.parseIntWithDefault(result[2]) * 60 +
            this.parseIntWithDefault(result[3]);
        }
      },

      parseIntWithDefault: function(num, def) {
        return parseInt(num, 10) || def || 0;
      },

      addInsignificantZero: function(n) {
        return ( n < 10 ? '0' : '') + n;
      }
    }
  };
}());
