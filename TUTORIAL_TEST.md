# Tutorial System Test Guide

## How to Test the New PNG Tutorial System

### 1. Reset Tutorial State
To test the tutorial as a new user, run this in the browser console:
```javascript
// Reset tutorial state
localStorage.removeItem('charityStream_tutorialSeen');
localStorage.setItem('charityStream_newUser', 'true');

// Reload the page
window.location.reload();
```

### 2. Expected Behavior

#### Step 1: Welcome Modal
- A modal should appear asking "Would you like a quick tutorial?"
- Two buttons: "No" and "Yes"

#### Step 2: Tutorial Slides (if "Yes" clicked)
- The tutorial backdrop should appear
- First slide should show "Wireframe - 2.png"
- Invisible "Next" button in top-right area
- Invisible "Exit" button in top-right corner
- Keyboard navigation: Arrow Right, Enter, Escape

#### Step 3: Navigation
- Click "Next" areas to advance through slides 2-9
- Each slide should fade smoothly to the next
- Slides progress: Wireframe - 2.png → Wireframe - 3.png → ... → Wireframe - 10.png

#### Step 4: Final Slide (Wireframe - 10.png)
- Green play button should appear and pulse
- Clicking play button or pressing Enter should:
  - Close tutorial
  - Show "Tutorial Complete 🎉" modal
  - Mark tutorial as seen

#### Step 5: Completion
- "Get Started" button should close completion modal
- Tutorial state should be saved (won't show again)

### 3. Testing Different Scenarios

#### Skip Tutorial
- Click "No" on welcome modal
- Should mark tutorial as seen and not show again

#### Exit During Tutorial
- Click "Exit" button (top-right corner) during slides
- Should close tutorial and mark as seen

#### Keyboard Navigation
- **Arrow Right**: Next slide
- **Enter**: Next slide (or start stream on final slide)
- **Escape**: Exit tutorial

### 4. Verification

#### Check Tutorial State
```javascript
// Check if tutorial has been seen
console.log('Tutorial seen:', localStorage.getItem('charityStream_tutorialSeen'));

// Check if new user flag is set
console.log('New user:', localStorage.getItem('charityStream_newUser'));
```

#### Test Reset Function
```javascript
// Use the built-in reset function
window.tutorialManager.resetTutorial();
window.location.reload();
```

### 5. Expected Files
The following files should exist in `public/tutorial/`:
- Wireframe - 2.png
- Wireframe - 3.png
- Wireframe - 4.png
- Wireframe - 5.png
- Wireframe - 6.png
- Wireframe - 7.png
- Wireframe - 8.png
- Wireframe - 9.png
- Wireframe - 10.png

### 6. Troubleshooting

#### Tutorial Not Showing
1. Check if `charityStream_tutorialSeen` is set to 'true'
2. Ensure `charityStream_newUser` is set to 'true'
3. Check browser console for errors

#### Images Not Loading
1. Verify PNG files exist in `public/tutorial/`
2. Check file permissions
3. Check browser network tab for 404 errors

#### Buttons Not Working
1. Check if elements exist: `tutorialHotNext`, `tutorialHotExit`, `tutorialHotPlay`
2. Verify event listeners are attached
3. Check for JavaScript errors in console

### 7. Integration with Existing System

The new tutorial system preserves all existing functionality:
- ✅ Tutorial completion tracking (`charityStream_tutorialSeen`)
- ✅ New user detection (`charityStream_newUser`)
- ✅ Video/popup pausing during tutorial
- ✅ Integration with authentication system
- ✅ Modal system for welcome/completion messages

The tutorial will only show for:
- New users (with `charityStream_newUser` flag)
- Authenticated users who haven't seen the tutorial
- Users who haven't completed the tutorial before
