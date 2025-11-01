// live-feedback.js
// Real-time exercise feedback system using MediaPipe angles and body part detection
// Now ROM-aware (calibration), level-aware, with down→up coaching for shoulder abduction.

class LiveFeedback {
  constructor() {
    this.feedbackElement = null;
    this.currentFeedback = '';
    this.lastFeedbackTime = 0;
    this.feedbackCooldown = 1500; // ms
    this.angleTolerance = 15; // deg

    // ROM / Level state
    this.level = 1;
    this.levels = 3;
    this.calib = null;

    // Derived thresholds (normalized y; smaller y == higher on screen)
    this.targetY = 0.6;         // where we want hands to reach
    this.neutralY = 0.78;       // where "down" lives
    this.downBuffer = 0.02;     // must go a bit below (numerically greater than) neutralY to reset
    this.requireDownFrames = 8; // how long to stay down between reps
    this.requireUpFrames = 5;   // how long to stay up near target

    // Phase hinting (optional—will be driven by exercise via setPhase)
    this.phase = "up";          // "up" | "waitDown"
    this._downCounter = 0;
    this._upCounter = 0;
  }

  /* ---------- Wiring ---------- */
  init(feedbackElementId) {
    this.feedbackElement = document.getElementById(feedbackElementId);
    if (!this.feedbackElement) {
      console.warn('Live feedback element not found:', feedbackElementId);
    }
  }

  setLevel(level, levels, calib) {
    // Persist session context
    this.level = Math.max(1, Number(level) || 1);
    this.levels = Math.max(this.level, Number(levels) || this.level);
    this.calib = calib || this.calib;

    // Read ROM from calibration if available
    const neutral = this._safeNum(this.calib?.rom?.neutralY, 0.78);
    const maxYL  = this._safeNum(this.calib?.rom?.maxReachLeftY, 0.18);
    const maxYR  = this._safeNum(this.calib?.rom?.maxReachRightY, 0.18);
    const maxY   = Math.min(maxYL, maxYR);

    this.neutralY = neutral;

    // Gentle ROM ramp: neutral -> maxY using 0.15..0.65 of the span
    const t = (this.level - 1) / Math.max(1, this.levels - 1); // 0..1
    const frac = 0.15 + 0.50 * t; // slower increments
    this.targetY = this._lerp(neutral, maxY, frac);
  }

  setPhase(phase) {
    // Optional hook so exercise can tell us "up" or "waitDown"
    if (phase === "up" || phase === "waitDown") {
      this.phase = phase;
      // reset counters when phase changes
      this._downCounter = 0;
      this._upCounter = 0;
    }
  }

  /* ---------- Helpers ---------- */
  _safeNum(v, fallback) { v = Number(v); return Number.isFinite(v) ? v : fallback; }
  _lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

  // Calculate angle between three points
  calculateAngle(a, b, c) {
    if (!a || !b || !c) return null;
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180 / Math.PI);
    if (angle > 180) angle = 360 - angle;
    return angle;
  }

  // Calculate distance between two points
  calculateDistance(a, b) {
    if (!a || !b) return null;
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
  }

  // Landmark visibility
  isVisible(landmark, threshold = 0.5) {
    return landmark && (landmark.visibility ?? 0) > threshold;
  }

  // UI feedback
  showFeedback(message, type = 'correction') {
    if (!this.feedbackElement || !message) return;
    const now = Date.now();
    if (now - this.lastFeedbackTime < 500) return; // anti-spam

    this.currentFeedback = message;
    this.lastFeedbackTime = now;

    this.feedbackElement.textContent = message;
    this.feedbackElement.className = `live-feedback-container ${type}`;

    setTimeout(() => {
      if (this.currentFeedback === message) {
        this.feedbackElement.textContent = '';
        this.feedbackElement.className = 'live-feedback-container';
      }
    }, this.feedbackCooldown);
  }

  /* ---------- Exercise-specific feedback ---------- */

  // Shoulder Abduction (ROM + down→up coaching)
  provideShoulderAbductionFeedback(landmarks) {
    if (!landmarks) return;

    const Ls = landmarks[11], Rs = landmarks[12];
    const Le = landmarks[13], Re = landmarks[14];
    const Lw = landmarks[15], Rw = landmarks[16];

    // basic visibility
    if (!this.isVisible(Ls) || !this.isVisible(Rs)) {
      this.showFeedback("Keep both shoulders visible", "warning");
      return;
    }

    // shoulders level
    const shoulderDiff = Math.abs(Ls.y - Rs.y);
    if (shoulderDiff > 0.05) {
      this.showFeedback("Keep your shoulders level", "correction");
      return;
    }

    // elbows fairly straight
    if (this.isVisible(Le) && this.isVisible(Lw)) {
      const a = this.calculateAngle(Ls, Le, Lw);
      if (a && a < 160) { this.showFeedback("Straighten your left elbow", "correction"); return; }
    }
    if (this.isVisible(Re) && this.isVisible(Rw)) {
      const a = this.calculateAngle(Rs, Re, Rw);
      if (a && a < 160) { this.showFeedback("Straighten your right elbow", "correction"); return; }
    }

    // Use wrists as hand position proxy
    if (!this.isVisible(Lw) || !this.isVisible(Rw)) {
      this.showFeedback("Keep your hands visible", "warning");
      return;
    }

    // Height checks (smaller y == higher)
    const leftUpEnough  = Lw.y <= (this.targetY + 0.02);
    const rightUpEnough = Rw.y <= (this.targetY + 0.02);

    // Phase-aware coaching (optional: exercise can call setPhase)
    if (this.phase === "waitDown") {
      // Encourage lowering arms
      const downLimitY = this.neutralY + this.downBuffer; // must be numerically >= this to be "down"
      const leftDown  = Lw.y >= downLimitY;
      const rightDown = Rw.y >= downLimitY;

      this._downCounter = (leftDown && rightDown) ? this._downCounter + 1 : 0;

      if (!leftDown && !rightDown) {
        this.showFeedback("Lower both arms to reset", "correction");
      } else if (!leftDown) {
        this.showFeedback("Lower your left arm to reset", "correction");
      } else if (!rightDown) {
        this.showFeedback("Lower your right arm to reset", "correction");
      } else if (this._downCounter >= this.requireDownFrames) {
        this.showFeedback("Great reset! Ready for the next rep", "success");
      }
      return;
    }

    // "Up" phase: encourage reaching target height
    if (!leftUpEnough && !rightUpEnough) {
      this.showFeedback("Raise both arms higher", "correction");
      this._upCounter = 0;
      return;
    }
    if (!leftUpEnough) {
      this.showFeedback("Raise your left arm higher", "correction");
      this._upCounter = 0;
      return;
    }
    if (!rightUpEnough) {
      this.showFeedback("Raise your right arm higher", "correction");
      this._upCounter = 0;
      return;
    }

    // Both are at target — hold briefly for a confident cue
    this._upCounter++;
    if (this._upCounter >= this.requireUpFrames) {
      this.showFeedback("Nice height! Hold…", "success");
    }
  }

  // Overhead Press feedback (unchanged)
  provideOverheadPressFeedback(landmarks) {
    if (!landmarks) return;

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftElbow = landmarks[13];
    const rightElbow = landmarks[14];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];

    if (!this.isVisible(leftShoulder) || !this.isVisible(rightShoulder)) {
      this.showFeedback("Keep both shoulders visible", "warning");
      return;
    }

    const nose = landmarks[0];
    if (this.isVisible(nose) && this.isVisible(leftWrist) && this.isVisible(rightWrist)) {
      const leftWristAboveHead = leftWrist.y < nose.y - 0.1;
      const rightWristAboveHead = rightWrist.y < nose.y - 0.1;

      if (!leftWristAboveHead && !rightWristAboveHead) {
        this.showFeedback("Press both hands higher - above your head", "correction");
        return;
      } else if (!leftWristAboveHead) {
        this.showFeedback("Press your left hand higher", "correction");
        return;
      } else if (!rightWristAboveHead) {
        this.showFeedback("Press your right hand higher", "correction");
        return;
      }
    }

    if (this.isVisible(leftElbow) && this.isVisible(leftWrist)) {
      const leftElbowAngle = this.calculateAngle(leftShoulder, leftElbow, leftWrist);
      if (leftElbowAngle && leftElbowAngle < 160) {
        this.showFeedback("Extend your left arm fully", "correction");
        return;
      }
    }

    if (this.isVisible(rightElbow) && this.isVisible(rightWrist)) {
      const rightElbowAngle = this.calculateAngle(rightShoulder, rightElbow, rightWrist);
      if (rightElbowAngle && rightElbowAngle < 160) {
        this.showFeedback("Extend your right arm fully", "correction");
        return;
      }
    }

    if (this.isVisible(nose) && this.isVisible(leftWrist) && this.isVisible(rightWrist)) {
      const bothHandsUp = leftWrist.y < nose.y - 0.1 && rightWrist.y < nose.y - 0.1;
      if (bothHandsUp) {
        this.showFeedback("Great! Both hands are up!", "success");
      }
    }
  }

  // Forward Reach feedback (unchanged)
  provideForwardReachFeedback(landmarks) {
    if (!landmarks) return;

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];

    if (!this.isVisible(leftShoulder) || !this.isVisible(rightShoulder)) {
      this.showFeedback("Keep both shoulders visible", "warning");
      return;
    }

    if (this.isVisible(leftWrist) && this.isVisible(rightWrist)) {
      const leftReaching = leftWrist.x < leftShoulder.x - 0.1;
      const rightReaching = rightWrist.x > rightShoulder.x + 0.1;

      if (!leftReaching && !rightReaching) {
        this.showFeedback("Reach forward with your arms", "correction");
        return;
      }
    }

    const shoulderDifference = Math.abs(leftShoulder.y - rightShoulder.y);
    if (shoulderDifference > 0.05) {
      this.showFeedback("Keep shoulders level while reaching", "correction");
      return;
    }

    this.showFeedback("Good reach! Hold the position", "success");
  }

  // Mini Squats feedback (unchanged)
  provideMiniSquatsFeedback(landmarks) {
    if (!landmarks) return;

    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];

    if (!this.isVisible(leftHip) || !this.isVisible(rightHip) || 
        !this.isVisible(leftKnee) || !this.isVisible(rightKnee) ||
        !this.isVisible(leftAnkle) || !this.isVisible(rightAnkle)) {
      this.showFeedback("Show your full body - hips, knees, and ankles", "warning");
      return;
    }

    const leftKneeAngle = this.calculateAngle(leftHip, leftKnee, leftAnkle);
    const rightKneeAngle = this.calculateAngle(rightHip, rightKnee, rightAnkle);
    if (!leftKneeAngle || !rightKneeAngle) return;

    const minSquatAngle = 140;
    const maxSquatAngle = 170;

    if (leftKneeAngle > maxSquatAngle && rightKneeAngle > maxSquatAngle) {
      this.showFeedback("Bend your knees more - mini squat down", "correction");
      return;
    }

    if (leftKneeAngle < minSquatAngle || rightKneeAngle < minSquatAngle) {
      this.showFeedback("Don't squat too deep - keep it mini", "correction");
      return;
    }

    const kneeAlignment = Math.abs(leftKnee.x - leftAnkle.x) + Math.abs(rightKnee.x - rightAnkle.x);
    if (kneeAlignment > 0.1) {
      this.showFeedback("Keep knees aligned over your ankles", "correction");
      return;
    }

    const leftHipKneeDistance = Math.abs(leftHip.y - leftKnee.y);
    const rightHipKneeDistance = Math.abs(rightHip.y - rightKnee.y);
    if (leftHipKneeDistance < 0.1 || rightHipKneeDistance < 0.1) {
      this.showFeedback("Perfect squat depth!", "success");
    }
  }

  // Marching in Place feedback (unchanged)
  provideMarchingFeedback(landmarks) {
    if (!landmarks) return;

    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];

    if (!this.isVisible(leftHip) || !this.isVisible(rightHip) || 
        !this.isVisible(leftKnee) || !this.isVisible(rightKnee)) {
      this.showFeedback("Show your full body for marching", "warning");
      return;
    }

    const leftKneeLifted = leftKnee.y < leftHip.y - 0.05;
    const rightKneeLifted = rightKnee.y < rightHip.y - 0.05;

    const leftKneeHeight = leftHip.y - leftKnee.y;
    const rightKneeHeight = rightHip.y - rightKnee.y;

    if (!leftKneeLifted && !rightKneeLifted) {
      this.showFeedback("Lift your knees higher - march in place", "correction");
      return;
    }

    if (leftKneeLifted && leftKneeHeight < 0.08) {
      this.showFeedback("Lift your left knee higher", "correction");
      return;
    }

    if (rightKneeLifted && rightKneeHeight < 0.08) {
      this.showFeedback("Lift your right knee higher", "correction");
      return;
    }

    if (this.isVisible(leftAnkle)) {
      const leftHipKneeAngle = this.calculateAngle(leftHip, leftKnee, leftAnkle);
      if (leftHipKneeAngle && leftHipKneeAngle < 90 && leftKneeLifted) {
        this.showFeedback("Good left knee lift!", "success");
      }
    }

    if (this.isVisible(rightAnkle)) {
      const rightHipKneeAngle = this.calculateAngle(rightHip, rightKnee, rightAnkle);
      if (rightHipKneeAngle && rightKneeLifted && rightHipKneeAngle < 90) {
        this.showFeedback("Good right knee lift!", "success");
      }
    }

    const shoulderMidpoint = {
      x: (landmarks[11].x + landmarks[12].x) / 2,
      y: (landmarks[11].y + landmarks[12].y) / 2
    };
    const hipMidpoint = {
      x: (leftHip.x + rightHip.x) / 2,
      y: (leftHip.y + rightHip.y) / 2
    };

    const posturalAlignment = Math.abs(shoulderMidpoint.x - hipMidpoint.x);
    if (posturalAlignment > 0.05) {
      this.showFeedback("Stand up straight - align your body", "correction");
      return;
    }
  }

  // Dispatcher
  provideFeedback(exerciseCriteria, landmarks) {
    if (!landmarks || !exerciseCriteria) return;

    switch (exerciseCriteria) {
      case 'shoulderAbduction':
        this.provideShoulderAbductionFeedback(landmarks);
        break;
      case 'overheadPress':
        this.provideOverheadPressFeedback(landmarks);
        break;
      case 'forwardReach':
        this.provideForwardReachFeedback(landmarks);
        break;
      case 'miniSquats':
        this.provideMiniSquatsFeedback(landmarks);
        break;
      case 'marchingInPlace':
        this.provideMarchingFeedback(landmarks);
        break;
      default:
        if (!this.isVisible(landmarks[11]) || !this.isVisible(landmarks[12])) {
          this.showFeedback("Keep your body visible", "warning");
        }
        break;
    }
  }

  // Clear all feedback
  clearFeedback() {
    if (this.feedbackElement) {
      this.feedbackElement.textContent = '';
      this.feedbackElement.className = 'live-feedback-container';
    }
    this.currentFeedback = '';
    this._downCounter = 0;
    this._upCounter = 0;
  }
}

// Create global instance
window.liveFeedback = new LiveFeedback();

console.log('live-feedback.js loaded');
