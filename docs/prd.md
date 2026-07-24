# Requirements Document

## 1. Application Overview

**Application Name**: SylvaCrypt (Secure Anonymous Chat Platform)

**Version**: v6.0.0

**Description**: A web-based anonymous chat application that prioritizes user privacy and security. Users can create or join chat rooms without registration, communicate anonymously, and benefit from end-to-end encryption. The platform includes a built-in VPN service (limited to 30 minutes per day) and automatic message deletion after 30 days to ensure data privacy.

**Application URL**: https://sylvacrypt.vercel.app/

**Tech Stack**: React + TypeScript + Vite + Tailwind + shadcn/ui, Supabase for backend/auth/realtime, IndexedDB for local encrypted storage

## 2. Users and Usage Scenarios

**Target Users**:
- Privacy-conscious individuals seeking secure communication
- Users who prefer anonymous online interactions
- People in regions with internet restrictions
- Individuals concerned about data retention and surveillance

**Core Usage Scenarios**:
- Anonymous group discussions on sensitive topics
- Secure one-on-one conversations without identity disclosure
- Temporary communication channels for short-term collaboration
- Accessing restricted content via integrated VPN service

## 3. Page Structure and Functionality

```
├── Landing Page
├── Room Creation Page
├── Room Joining Page
├── Chat Room Page
│   ├── Message Input Area
│   ├── Message Display Area
│   ├── Message Context Menu (overlay)
│   ├── Reaction Palette (overlay)
│   ├── User List Panel
│   ├── Room Settings Panel
│   └── Pin Management Panel (overlay)
├── VPN Control Panel (overlay)
├── Settings Page
│   ├── Customization Section
│   ├── Theme Scheduling Section
│   ├── Keyboard Shortcuts Section
│   └── Push Notifications Section
├── Themes Page
│   ├── Preset Themes Section
│   └── Custom Theme Editor (overlay)
├── Contact Exchange Page
├── Contact Notification Settings Page
├── Privacy Policy and Terms of Service Page
├── Push Notification Permission Dialog (overlay)
├── Service Worker Update Prompt (overlay)
└── Crypto Worker (background)
```

### 3.1 Landing Page

**Purpose**: Entry point for users to access the platform

**Functionality**:
- Display application name and brief description
- Provide two primary action buttons: Create Room and Join Room
- Show VPN status indicator
- Display theme toggle button
- For users with Keep me signed in enabled, skip authentication page and load directly to Landing Page
- Support keyboard shortcuts for navigation

### 3.2 Room Creation Page

**Purpose**: Allow users to create new chat rooms

**Functionality**:
- Display input field for room name (optional, auto-generated if empty)
- Provide Create button to generate room
- Upon creation, generate unique room link and display it to user
- Provide Copy Link button to copy room URL to clipboard
- Provide Enter Room button to join the created room directly
- Show Back button to return to Landing Page

### 3.3 Room Joining Page

**Purpose**: Allow users to join existing chat rooms

**Functionality**:
- Display input field for room link or room ID
- Provide Join button to enter the specified room
- Validate room link/ID format before joining
- Show error message if room does not exist or link is invalid
- Show Back button to return to Landing Page

### 3.4 Chat Room Page

**Purpose**: Main interface for real-time communication

**Core Components**:

#### 3.4.1 Message Input Area
- Text input field for composing messages
- Send button to submit message
- Support Enter key to send message (configurable via keyboard shortcuts)
- Support Shift+Enter for line breaks
- Display character count indicator
- Show Reply indicator when replying to a message, with cancel button
- Provide emoji picker button with functional search capability
- Provide View Once toggle option to mark message as view-once before sending
- Provide TTL selector to set self-destruct timer for disappearing messages (optional)
- Support keyboard shortcut to focus composer

#### 3.4.2 Message Display Area
- Display messages in chronological order using cursor-based pagination
- Load messages incrementally as user scrolls up to improve performance
- Show each message with:
  - Anonymous username
  - Message content
  - Timestamp
  - Delivery status indicator
  - Pin indicator icon for pinned messages
  - View Once indicator for view-once messages (before viewing)
  - TTL countdown indicator for disappearing messages
  - Reaction indicators showing emoji reactions and count
- Support text wrapping for long messages
- Auto-scroll to latest message when new message arrives
- Display quoted message preview in reply bubbles
- Support tapping/clicking quoted preview to scroll to original message
- Show image thumbnails in quoted previews when replying to image messages
- Support long-press or right-click on message to open Message Context Menu
- View-once messages disappear immediately after being viewed, leaving no trace in chat history
- Disappearing messages are automatically deleted after TTL expires
- Validate certificate chain for every received message before display
- Honor prefers-reduced-motion for animations

#### 3.4.3 Message Context Menu (overlay)
- Appears when user long-presses or right-clicks a message
- Display options:
  - Reply to reply to the message
  - React to open Reaction Palette
  - Delete for me to delete message for current user only
  - Pin for me to pin message for current user only
  - Pin for everyone to pin message for all users in the room
  - Other standard message actions
- Dismiss menu when user selects an option or clicks outside

#### 3.4.4 Reaction Palette (overlay)
- Appears when user selects React option from Message Context Menu
- Display emoji picker with most frequently used emojis shown at the top for better accessibility
- Support emoji search functionality
- Allow user to select emoji to react to message
- Dismiss palette when user selects an emoji or clicks outside

#### 3.4.5 User List Panel
- Display list of currently active users in the room
- Show anonymous usernames
- Display user count
- Indicate current user with special marker

#### 3.4.6 Room Settings Panel
- Display current room name
- Show room link with Copy Link button
- Provide Leave Room button to exit and return to Landing Page
- Display auto-delete policy information (30 days)
- Provide View Pinned Messages button to open Pin Management Panel
- Provide Mute Room button (keyboard shortcut available)

#### 3.4.7 Pin Management Panel (overlay)
- Display list of all pinned messages in the room
- Show separate sections for:
  - Messages pinned for current user only (up to 50 pins)
  - Messages pinned for everyone (up to 25 pins)
- Each pinned message shows:
  - Message content preview
  - Sender username
  - Timestamp
  - Unpin button
  - Jump to message button to navigate to original message in chat
- Provide Close button to dismiss panel
- Support tapping message to navigate to original message in chat

### 3.5 VPN Control Panel (overlay)

**Purpose**: Manage VPN connection for privacy protection

**Functionality**:
- Display VPN connection status (connected/disconnected)
- Show remaining daily usage time (out of 30 minutes)
- Provide Connect button to activate VPN
- Provide Disconnect button to deactivate VPN
- Display usage timer when VPN is active
- Show warning when approaching daily limit
- Auto-disconnect when daily limit is reached
- Reset usage timer at midnight (local time)

### 3.6 Settings Page

**Purpose**: Central hub for application settings and customization

**Functionality**:
- Display various settings sections including:
  - Customization Section with clickable link/button to Themes Page
  - Theme Scheduling Section with toggle to enable/disable auto theme switching based on time of day
  - Keyboard Shortcuts Section displaying all available shortcuts and allowing customization
  - Push Notifications Section with functional toggle button to enable/disable push notifications
  - Accessibility Section with reduced-motion toggle
  - Other settings sections as needed
- Ensure Themes button/link is functional and navigates to Themes Page when clicked
- Ensure Push Notifications toggle button correctly updates notification preference state
- Provide Back button to return to previous page

### 3.7 Themes Page

**Purpose**: Allow users to select and apply different visual themes, including preset themes and custom themes

**Functionality**:

#### 3.7.1 Preset Themes Section
- Display available preset theme options:
  - Light (default light theme)
  - Dark (default dark theme)
  - Mint (light mode with teal message bubbles and mint send button)
  - Mint Dark (dark mode with teal message bubbles and mint send button)
  - Warm Paper (warm, paper-like, easy on the eyes)
  - Neon Noir (deep black with electric cyan accents)
- Show theme preview thumbnails for each option
- Provide selection button for each theme
- Apply selected theme immediately to all UI elements across the entire application
- Ensure theme styles are correctly loaded and rendered for all components
- Persist theme preference in browser local storage immediately upon selection
- Load persisted theme preference on app startup and apply it before rendering UI

#### 3.7.2 Custom Theme Editor (overlay)
- Provide Create Custom Theme button to open Custom Theme Editor
- Display list of user's existing custom themes (both private and public)
- For each custom theme, show:
  - Theme name
  - Preview thumbnail
  - Edit button
  - Delete button
  - Privacy status (Private/Public)
  - Toggle to switch between Private and Public
- Custom Theme Editor allows users to:
  - Name the custom theme (mandatory before saving or publishing)
  - Select color for message bubble
  - Select color for send button
  - Select color for background
  - Select colors for other individual UI components
  - Select font for messages and other text
  - Select background image from device storage (optional)
  - Save theme as draft (not usable until named)
  - Save theme as private (usable only by creator)
  - Publish theme as public (visible and usable by all users)
- Until theme is named, it remains as draft and cannot be used or published
- Provide Save as Draft, Save as Private, and Publish as Public buttons
- Provide Cancel button to close editor without saving
- Show Back button to return to Themes Page

### 3.8 Contact Exchange Page

**Purpose**: Enable users to exchange contacts via QR code scanning

**Functionality**:
- Display user's unique QR code for contact exchange
- Provide QR code scanner to scan other users' codes (loaded as lazy chunk)
- When user A scans user B's QR code:
  - User A is directly added to user B's contact list without approval
  - User B is directly added to user A's contact list
- For users with Keep me signed in enabled:
  - Support scanning QR code from any external QR code scanner app
  - Automatically add scanned user to contacts upon successful scan
- Display confirmation message after successful contact exchange
- Show Back button to return to previous page

### 3.9 Push Notification Permission Dialog (overlay)

**Purpose**: Request user permission for push notifications and background operation

**Functionality**:
- Appear on first app launch or when user enables push notifications in settings
- Display explanation of notification types:
  - New message decrypted in vault notifications (for selected contacts)
  - Other relevant event notifications
- Request permission to run app in background
- Provide Allow and Deny buttons
- When user clicks Allow:
  - Trigger browser's native push notification permission request
  - If granted, register service worker for push notifications
  - Store permission status in local storage
- When user clicks Deny:
  - Store denial status in local storage
  - Dismiss dialog without requesting browser permission
- Persist user's choice in browser settings
- Support platform-specific permission flows
- Do not show dialog again if user has already granted or denied permission

### 3.10 Service Worker Update Prompt (overlay)

**Purpose**: Notify users when a new service worker version is available

**Functionality**:
- Appear when a new service worker is waiting to activate
- Display message explaining that a new version is available
- Provide Update Now button to activate the new service worker
- Provide Later button to dismiss the prompt
- Ensure users are prompted to update for security fixes

### 3.11 Contact Notification Settings Page

**Purpose**: Allow users to configure per-contact notification preferences

**Functionality**:
- Display list of all contacts
- For each contact, provide toggle option:
  - Receive vault message notifications (on/off)
- Respect Do Not Disturb (DND) and mute settings
- Save preferences and sync across devices
- Show Back button to return to previous page

### 3.12 Privacy Policy and Terms of Service Page

**Purpose**: Display platform's privacy policy and terms of service, including custom theme background image usage guidelines

**Functionality**:
- Display complete privacy policy text
- Display complete terms of service text
- Include section on Custom Theme Background Image Usage Guidelines:
  - Users should use images as background of custom theme only if image meets following criteria:
    - User has permissions/rights to use that image
    - Image is non-abusive
    - Image does not contain any explicit or adult content
    - Image does not have any personal/private data
    - Image does not depict any illegal activities
    - Image should not depict any violent, self-harming, aggressive, or dangerous activities
  - Public Themes standard: any image attached to a Public Theme undergoes strict compliance with community guidelines, as it will be visible/downloadable by other users
  - Right to Remove: SylvaCrypt reserves the right to unpublish, delete, or revert any theme if it violates the community standards
- Provide scrollable text area for long content
- Show Back button to return to previous page

### 3.13 Crypto Worker (background)

**Purpose**: Offload cryptographic operations to Web Worker to prevent UI blocking

**Functionality**:
- Handle all encryption/decryption operations in background thread
- Process key derivation (Argon2id) for vault and recovery phrase
- Perform certificate chain validation
- Execute E2EE push notification payload decryption
- Return results to main thread via message passing
- Ensure no blocking of UI rendering during crypto operations

## 4. Business Rules and Logic

### 4.1 Room Management
- Each room has a unique identifier (room ID) and shareable link
- Room names are optional; if not provided, system generates random name
- Rooms persist as long as at least one user is connected
- Rooms are automatically deleted when all users leave
- Room links remain valid until room is deleted

### 4.2 User Identity and Anonymity
- No registration or login required
- Each user is assigned a random anonymous username upon joining a room
- Anonymous usernames are unique within a room but may repeat across different rooms
- User identity is not tracked across sessions or rooms
- Backend assigns pseudo email IDs to users in format {username}@sylvacrypt.com for internal identification
- All existing users with @shadowcrypt.com email format must be migrated to @sylvacrypt.com format
- All future users must be assigned @sylvacrypt.com email format directly upon creation

### 4.3 Message Encryption and Storage
- All messages are end-to-end encrypted using client-side encryption
- Messages are stored on backend server in encrypted form
- Encryption keys are generated and managed on client side
- Messages are automatically deleted from server after 30 days from creation time
- Deleted messages cannot be recovered
- Certificate chain for every received message must be validated before display
- KEM failure during encryption or decryption triggers hard failure or session reset instead of silent classical fallback
- All cryptographic operations are offloaded to Web Worker to prevent UI blocking

### 4.4 Recovery Phrase KDF Migration
- Recovery phrase hash is migrated from PBKDF2 to Argon2id to match vault security
- Migration is transparent and occurs automatically on next unlock
- Legacy PBKDF2 hashes are detected and re-hashed using Argon2id
- New recovery phrases use Argon2id directly
- Migration status is tracked in IndexedDB

### 4.5 Self-Destructing / Disappearing Messages
- Users can set TTL (Time To Live) for messages before sending
- TTL options: 30 seconds, 1 minute, 5 minutes, 1 hour, 1 day, 7 days, custom
- Disappearing messages display countdown timer in Message Display Area
- Messages are automatically deleted from all devices after TTL expires
- Deletion is enforced both client-side and server-side
- Disappearing messages cannot be pinned or replied to after expiration
- TTL countdown starts from message send time

### 4.6 Password Breach Checking
- During registration and password changes, password is checked against Have I Been Pwned database
- Password hash prefix (first 5 characters of SHA-1 hash) is sent to server
- Server queries Have I Been Pwned API using k-anonymity model
- If password is found in breach database, user is warned and prompted to choose a different password
- User can override warning and proceed with breached password (not recommended)
- Breach check is performed server-side to protect user privacy

### 4.7 E2EE Push Notification Payloads
- Push notification payloads are fully end-to-end encrypted
- Server only sees ciphertext; cannot read notification title or body
- Client decrypts notification payload using local keys after receiving push
- Decryption occurs in Crypto Worker to prevent UI blocking
- Notification title and body are displayed only after successful decryption
- If decryption fails, generic notification is shown

### 4.8 Message Delivery and Status
- Messages are sent to backend server immediately upon user submission
- Backend broadcasts messages to all connected users in the room
- Delivery status is updated when message is successfully received by backend
- No read receipts are provided beyond delivery confirmation

### 4.9 Message Reply Logic
- Users can reply to any message in the chat history
- Replying to a message creates a quoted reference in the reply bubble
- Quoted preview shows original message sender, timestamp, and content snippet (first 50 characters)
- If replying to an image message, quoted preview shows image thumbnail (loaded as lazy chunk)
- Tapping/clicking quoted preview scrolls chat to the original message
- Reply relationships are preserved in message data structure

### 4.10 Message Action Logic
- Users can perform the following actions on any message (including their own messages):
  - Delete for me: Message is deleted only for current user, remains visible to others
  - Pin for me: Message is pinned only for current user, visible only in their Pin Management Panel (up to 50 pins per conversation)
  - Pin for everyone: Message is pinned for all users in the room, visible to everyone (up to 25 pins per conversation, if user has permission)
  - React: User can add emoji reaction to message
- Pinned messages display a pin indicator icon in the Message Display Area
- Users can view all pinned messages in the Pin Management Panel
- Users can unpin messages they have pinned
- Pinned messages remain pinned until manually unpinned or until the message is auto-deleted after 30 days
- Pinned messages are tied to conversation/message IDs and sync across devices
- Pin data is restored alongside messages when syncing to a new device
- Jump to message action in Pin Management Panel navigates directly to the pinned message in chat history

### 4.11 Message Reaction Logic
- Users can react to any message using emoji reactions
- Reaction Palette displays most frequently used emojis at the top for better accessibility
- Users can search for emojis in Reaction Palette
- Each message can have multiple reactions from different users
- Reaction count is displayed next to each emoji on the message
- Users can remove their own reactions by clicking the reaction again

### 4.12 View Once Message Logic
- Users can mark a message as View Once before sending
- View-once messages display a special indicator before being viewed
- When recipient views a view-once message:
  - Message content is displayed normally
  - Message immediately disappears from chat history after viewing
  - No trace of the message remains in the chat
  - Optionally, sender is notified that the message was viewed, allowing sender's device to also tombstone the message
- View-once messages cannot be replied to, pinned, or forwarded
- Sender cannot view their own view-once message after sending
- View-once message consumption is handled entirely on the client side

### 4.13 Message Ordering
- Messages are always rendered in chronological order based on server timestamp
- Client-side timestamp is used as fallback if server timestamp is unavailable
- Message ordering is preserved across pagination and real-time updates
- Out-of-order messages are re-sorted automatically upon receipt

### 4.14 VPN Service Rules
- VPN service is integrated into the platform and accessible via VPN Control Panel
- Each user has a daily usage limit of 30 minutes
- Usage timer starts when VPN is connected and pauses when disconnected
- Daily limit resets at midnight (based on user's local time zone)
- When daily limit is reached, VPN automatically disconnects and cannot be reconnected until reset
- VPN usage is tracked per browser session (not across devices or browsers)

### 4.15 Theme Management
- User's theme preference is saved in browser local storage immediately upon selection
- Theme preference is loaded from local storage on app startup before rendering UI
- Theme preference is applied automatically when user revisits the platform
- Available preset themes: Light, Dark, Mint, Mint Dark, Warm Paper, Neon Noir
- When user selects a theme on Themes Page:
  - Theme styles must be immediately applied to all UI components across the entire application
  - All theme-specific CSS classes and styles must be correctly loaded and rendered
  - Theme change must be visible instantly without requiring page reload
- If no preference is saved, default theme is Light
- Users access theme selection via Settings Page > Customization Section > Themes Page
- Themes button in Settings Page must be functional and navigate to Themes Page when clicked

### 4.16 Custom Theme Management
- Users can create custom themes via Custom Theme Editor on Themes Page
- Custom themes allow users to:
  - Select colors for message bubble, send button, background, and other UI components
  - Select font for messages and other text
  - Select background image from device storage (optional)
- Custom themes must be named before they can be saved or published
- Until named, custom theme remains as draft and cannot be used
- Custom themes can be saved as:
  - Draft: Not usable, can be edited later
  - Private: Usable only by creator, not visible to other users
  - Public: Visible and usable by all users
- Users can edit or delete their own custom themes
- Users can toggle privacy status of their custom themes between Private and Public
- Custom theme preferences are saved in browser local storage
- Public custom themes are stored on backend server and accessible to all users
- Background images for custom themes must comply with usage guidelines stated in Privacy Policy and Terms of Service Page
- Public custom themes with non-compliant background images may be unpublished, deleted, or reverted by platform

### 4.17 Theme Auto-Scheduling
- Users can enable theme auto-scheduling from Customization Section in Settings Page
- When enabled, theme automatically switches based on time of day:
  - Light theme during daytime (e.g., 6:00 AM - 6:00 PM)
  - Dark theme during nighttime (e.g., 6:00 PM - 6:00 AM)
- Users can customize time ranges for auto-switching
- Auto-scheduling overrides manual theme selection during scheduled periods
- Manual theme selection disables auto-scheduling until re-enabled
- Auto-scheduling preference is saved in local storage

### 4.18 Keyboard Shortcuts
- Platform supports extensive keyboard shortcuts for navigation and actions:
  - Ctrl+K: Open command palette
  - Ctrl+N: Create new room
  - Escape: Close dialogs/overlays
  - Ctrl+Enter: Send message (configurable)
  - Ctrl+M: Mute/unmute room
  - Ctrl+F: Focus composer
  - Ctrl+Up/Down: Navigate between rooms
  - Ctrl+1-9: Switch to specific room
  - Other shortcuts as needed
- Users can view all shortcuts in Keyboard Shortcuts Section of Settings Page
- Users can customize shortcuts to match their preferences
- Shortcuts are saved in local storage

### 4.19 Accessibility and Reduced Motion
- Platform honors prefers-reduced-motion media query
- When reduced motion is preferred:
  - Animations are disabled or simplified
  - Transitions are instant or minimal
  - Auto-scroll behavior is adjusted
- Users can manually toggle reduced-motion support in Accessibility Section of Settings Page
- Reduced-motion preference is saved in local storage

### 4.20 Contact Exchange Logic
- Each user has a unique QR code for contact exchange
- When user A scans user B's QR code:
  - User A is directly added to user B's contact list
  - User B is directly added to user A's contact list
  - No approval or request process is required
- For users with Keep me signed in enabled:
  - QR code can be scanned from any external QR code scanner app
  - Scanned user is automatically added to contacts upon successful scan
- Contact exchange is bidirectional and instantaneous

### 4.21 Authentication and Session Management
- Users with Keep me signed in enabled should never see the authentication page on app open
- Session state is validated silently in the background
- If session is valid, user is directly navigated to Landing Page
- If session is invalid, user is prompted to re-authenticate

### 4.22 Push Notification Logic
- Push notifications are sent for the following events:
  - New message decrypted in vault: Generic wake-up notification with badge update, only for contacts with notification enabled in Contact Notification Settings Page
  - Other relevant events as determined by platform
- Push notification payloads are fully E2EE; server only sees ciphertext
- Client decrypts notification title and body using local keys
- Push notifications require user permission via Push Notification Permission Dialog
- Permission request flow:
  - Dialog appears on first app launch or when user enables notifications in settings
  - User clicks Allow to trigger browser's native permission request
  - If granted, service worker is registered for push notifications
  - If denied, dialog is dismissed and permission status is stored
- Notifications are delivered even when app is not in foreground
- Users can manage notification preferences in browser settings
- All user-identifying content is moved out of push payload; message details are fetched inside the app after unlock
- Respect Do Not Disturb (DND) and mute settings for vault message notifications
- Structured logging and failure alerting are implemented for push notification service
- Push Notifications toggle button in Settings Page must correctly update user's notification preference state when toggled
- Before sending push notifications, the push-notify Edge Function must verify:
  - Contact relationship exists between sender and recipient
  - Recipient has not blocked the sender
  - Only send notifications if both checks pass

### 4.23 PWA and Desktop Integration
- PWA manifest includes correct icon references for desktop shortcuts
- Desktop shortcut icon displays correctly on Windows/Desktop without generic letter tile or browser icon overlay
- PWA requests permission to run in background to enable push notifications
- PWA functions as a standalone app with full offline capabilities

### 4.24 Emoji Picker Functionality
- Emoji picker includes search functionality
- Search returns relevant emoji results based on user input
- If no matching emoji is found, display appropriate message (not No Emoji Found error)

### 4.25 Message Pagination and Performance
- Messages are loaded using cursor-based pagination instead of loading all messages at once
- Improves performance for long conversations
- Messages are loaded incrementally as user scrolls up in chat history

### 4.26 Service Worker Update Management
- When a new service worker is waiting to activate, prompt users with Service Worker Update Prompt
- Ensure users pick up security fixes quickly by encouraging immediate updates
- Users can choose to update immediately or defer to later

### 4.27 Code Splitting and Lazy Loading
- Application is split into multiple route-based chunks to reduce main bundle size
- Lazy-loaded routes:
  - Crypto operations route (loaded on demand)
  - Chat room route (loaded on demand)
  - Settings route (loaded on demand)
  - QR scanner functionality (loaded as lazy chunk)
  - Image preview routes (loaded as lazy chunks)
- Main bundle size is reduced to under 1 MB gzipped through route splitting and lazy loading
- Vite dynamic-import warnings are resolved by ensuring modules are imported either statically or dynamically, not both

### 4.28 IndexedDB Schema Versioning and Migration
- Robust IndexedDB schema versioning system is implemented
- Migration harness handles schema upgrades transparently
- Each schema version is tracked and migrations are applied sequentially
- Migration failures are logged and handled gracefully
- Data integrity is preserved during migrations

### 4.29 Offline Outbox Queue
- Messages sent while disconnected are queued in offline outbox
- Outbox is stored in IndexedDB
- When connection is restored, queued messages are sent automatically
- Outbox displays pending messages with sending status indicator
- Users can view and manage outbox from Chat Room Page
- Failed messages can be retried or deleted manually

### 4.30 Security Headers and CSP
- Security headers are configured in Nginx:
  - X-Content-Type-Options: nosniff
  - X-Frame-Options: DENY
  - X-XSS-Protection: 1; mode=block
  - Strict-Transport-Security: max-age=31536000; includeSubDomains
  - Referrer-Policy: no-referrer
- Content Security Policy (CSP) is implemented with nonces/hashes to reduce unsafe-inline reliance
- CSP reporting endpoint is configured to collect violation reports
- CSP violations are logged and monitored for security analysis

### 4.31 Database Store Cleanup
- Remove duplicated personal_pins delete logic in dbStore to ensure clean and maintainable codebase

## 5. Exception and Edge Cases

| Scenario | Handling |
|----------|----------|
| User loses internet connection during chat | Messages are queued in offline outbox and sent when connection is restored; user sees Reconnecting indicator |
| User tries to join a non-existent room | Display error message Room not found and remain on Room Joining Page |
| User tries to send empty message | Send button is disabled when input field is empty |
| User exceeds character limit in message | Display warning and prevent sending until message is shortened |
| Multiple users join room simultaneously | Backend handles concurrent connections; all users see updated user list |
| User closes browser tab while in room | User is automatically removed from room; other users see updated user list |
| VPN connection fails | Display error message VPN connection failed, please try again and keep VPN disconnected |
| User tries to connect VPN when daily limit is reached | Display message Daily VPN limit reached, resets at midnight and disable Connect button |
| User switches theme while VPN is active | Theme change applies immediately without affecting VPN connection |
| User copies room link but link is invalid | Pasting invalid link in Room Joining Page shows error Invalid room link format |
| Backend server is unreachable | Display error message Unable to connect to server, please check your internet connection |
| User tries to reply to a deleted message | Reply action is disabled for deleted messages; show tooltip Cannot reply to deleted message |
| User clicks quoted preview but original message is deleted | Show message Original message has been deleted |
| User tries to pin a view-once message | Pin action is disabled for view-once messages |
| User tries to reply to a view-once message | Reply action is disabled for view-once messages |
| User views a view-once message | Message disappears immediately from chat history with no trace; sender optionally notified |
| User with Keep me signed in enabled opens app | Authentication page is skipped, user is directly navigated to Landing Page |
| User denies push notification permission | App functions normally but push notifications are not delivered; permission status stored |
| User scans invalid QR code for contact exchange | Display error message Invalid QR code and remain on Contact Exchange Page |
| User scans QR code from external scanner while not signed in | Prompt user to sign in before adding contact |
| Emoji search returns no results | Display message No matching emoji instead of error |
| Desktop PWA shortcut icon does not display correctly | Ensure manifest.json includes correct icon paths and sizes for Windows/Desktop |
| User tries to unpin a message pinned by another user | Only allow unpinning if user has permission |
| User tries to pin more than 50 personal pins in a conversation | Display error message Personal pin limit reached (50 pins per conversation) |
| User tries to pin more than 25 shared pins in a conversation | Display error message Shared pin limit reached (25 pins per conversation) |
| User receives message with invalid certificate chain | Message is not displayed; error is logged |
| Push notification service fails to send notification | Failure is logged and alert is triggered for monitoring |
| User scrolls to top of long conversation | Messages are loaded incrementally using cursor-based pagination |
| New service worker is available but user dismisses prompt | Prompt reappears on next app launch or after a set interval |
| User tries to delete their own message using Delete for me | Message is deleted for current user only, remains visible to others |
| User tries to pin their own message using Pin for me | Message is pinned for current user only |
| User tries to pin their own message using Pin for everyone | Message is pinned for all users if user has permission |
| Themes button in Settings Page is clicked | Navigate to Themes Page |
| User selects a theme on Themes Page | Theme is applied immediately to all UI components and persisted in local storage |
| User reloads app after selecting a theme | Theme preference is loaded from local storage and applied before rendering UI |
| User clicks Allow in Push Notification Permission Dialog | Browser's native permission request is triggered; if granted, service worker is registered |
| User clicks Deny in Push Notification Permission Dialog | Dialog is dismissed and denial status is stored in local storage |
| Push Notification Permission Dialog appears when permission already granted | Dialog does not appear; permission status is checked before showing |
| User selects Mint theme but styles do not apply | Ensure all Mint theme CSS classes are correctly loaded and applied to all components |
| User selects Mint Dark theme but styles do not apply | Ensure all Mint Dark theme CSS classes are correctly loaded and applied to all components |
| User selects Warm Paper theme but styles do not apply | Ensure all Warm Paper theme CSS classes are correctly loaded and applied to all components |
| User selects Neon Noir theme but styles do not apply | Ensure all Neon Noir theme CSS classes are correctly loaded and applied to all components |
| Theme styles are not visible after selection | Verify theme stylesheet is loaded and CSS specificity is correct |
| User toggles Push Notifications button in Settings Page | Toggle button correctly updates notification preference state and persists change |
| Push Notifications toggle button does not respond to clicks | Ensure event handler is correctly bound and state update logic is functional |
| Existing user with @shadowcrypt.com email format logs in | Backend automatically migrates user's email to @sylvacrypt.com format |
| New user is created | Backend assigns email in @sylvacrypt.com format directly |
| Push notification sent to user who has blocked sender | Push-notify Edge Function verifies blocklist and does not send notification |
| Push notification sent to user without contact relationship | Push-notify Edge Function verifies contact relationship and does not send notification |
| KEM fails during message encryption | Trigger hard failure or session reset instead of silent classical fallback |
| KEM fails during message decryption | Trigger hard failure or session reset instead of silent classical fallback |
| User sets TTL for disappearing message | Message displays countdown timer and is deleted after TTL expires |
| User tries to pin disappearing message after expiration | Pin action is disabled for expired messages |
| User registers with breached password | Password breach check warns user and prompts to choose different password |
| User overrides breach warning | User can proceed with breached password (not recommended) |
| Push notification payload decryption fails | Generic notification is shown; decryption error is logged |
| Crypto Worker fails to respond | Main thread times out and displays error; operation is retried |
| User enables theme auto-scheduling | Theme switches automatically based on time of day |
| User manually changes theme while auto-scheduling is enabled | Auto-scheduling is disabled until re-enabled |
| User presses keyboard shortcut | Corresponding action is executed immediately |
| User enables reduced-motion | Animations are disabled or simplified |
| IndexedDB schema migration fails | Migration failure is logged; app attempts to recover or prompts user to clear data |
| User sends message while offline | Message is queued in offline outbox and sent when connection is restored |
| Offline outbox message fails to send | User can retry or delete failed message manually |
| CSP violation occurs | Violation is logged to CSP reporting endpoint for analysis |
| Vite dynamic-import warning appears | Ensure modules are imported either statically or dynamically, not both |
| Main bundle exceeds 1 MB gzipped | Further optimize code splitting and lazy loading to reduce bundle size |
| User creates custom theme without naming it | Theme is saved as draft and cannot be used or published |
| User tries to publish custom theme without naming it | Display error message Theme must be named before publishing |
| User selects background image for custom theme that violates guidelines | Display warning message and prevent saving/publishing until compliant image is selected |
| User publishes custom theme with non-compliant background image | Platform may unpublish, delete, or revert theme; user is notified |
| User edits existing custom theme | Changes are saved and theme is updated immediately |
| User deletes custom theme | Theme is removed from user's list and no longer usable |
| User toggles custom theme privacy status from Private to Public | Theme becomes visible and usable by all users |
| User toggles custom theme privacy status from Public to Private | Theme becomes invisible to other users and usable only by creator |
| User reacts to message with emoji | Reaction is added to message and displayed with count |
| User removes their own reaction | Reaction is removed from message and count is updated |
| User opens Reaction Palette and searches for emoji | Most frequently used emojis are displayed at top; search results are shown below |
| Reaction Palette search returns no results | Display message No matching emoji |

## 6. Acceptance Criteria

1. User opens the application and sees the Landing Page with Create Room and Join Room buttons
2. User clicks Create Room and is navigated to Room Creation Page
3. User clicks Create button and a new room is generated with a unique link displayed
4. User clicks Enter Room and is navigated to the Chat Room Page
5. User types a message in the input field and clicks Send button
6. Message appears in the Message Display Area with anonymous username and timestamp
7. User sees another user join the room and the User List Panel updates
8. User clicks Leave Room button and is returned to the Landing Page
9. User clicks Join Room on Landing Page and enters a valid room link
10. User clicks Join and successfully enters the existing room
11. User opens VPN Control Panel and clicks Connect button
12. VPN connects successfully and usage timer starts counting
13. User clicks Disconnect button and VPN disconnects, timer pauses
14. User navigates to Settings Page and clicks on Customization Section
15. User clicks on Themes button/link in Customization Section
16. User is navigated to Themes Page
17. User selects Mint theme from available options
18. Mint theme is immediately applied to all UI components with teal message bubbles and mint send button visible
19. All Mint theme styles are correctly rendered across the entire application
20. Mint theme preference is saved in browser local storage
21. User closes browser and reopens application
22. Mint theme is loaded from local storage and applied before rendering UI
23. User navigates to Settings Page and enables theme auto-scheduling
24. Theme automatically switches to Dark at 6:00 PM and Light at 6:00 AM
25. User manually changes theme while auto-scheduling is enabled
26. Auto-scheduling is disabled until user re-enables it
27. User navigates to Settings Page and views Keyboard Shortcuts Section
28. All available shortcuts are displayed with descriptions
29. User presses Ctrl+K and command palette opens
30. User presses Ctrl+M and room is muted/unmuted
31. User presses Ctrl+F and composer is focused
32. User navigates to Settings Page and enables reduced-motion
33. Animations are disabled or simplified across the application
34. User opens app for the first time and sees Push Notification Permission Dialog
35. User clicks Allow button and browser's native permission request is triggered
36. User grants permission and service worker is registered for push notifications
37. User receives E2EE push notification with encrypted payload
38. Client decrypts notification title and body using local keys
39. Decrypted notification is displayed to user
40. User sends a message and it is automatically deleted after 30 days
41. User sets TTL for disappearing message before sending
42. Message displays countdown timer in Message Display Area
43. Message is automatically deleted after TTL expires
44. User registers with password found in breach database
45. Password breach check warns user and prompts to choose different password
46. User chooses different password and registration succeeds
47. User unlocks vault with legacy PBKDF2 recovery phrase
48. Recovery phrase hash is transparently migrated to Argon2id
49. User unlocks vault again and Argon2id hash is used
50. User sends message while offline
51. Message is queued in offline outbox
52. Connection is restored and queued message is sent automatically
53. User views offline outbox and sees pending messages
54. User retries failed message from outbox
55. User deletes failed message from outbox
56. User opens app and main bundle size is under 1 MB gzipped
57. User navigates to Chat Room Page and route is lazy-loaded
58. User navigates to Settings Page and route is lazy-loaded
59. User opens QR scanner and functionality is lazy-loaded
60. User opens image preview and route is lazy-loaded
61. Vite build completes without dynamic-import warnings
62. User performs crypto operation and Crypto Worker handles it in background
63. UI remains responsive during crypto operation
64. User receives message and certificate chain is validated before display
65. Message with invalid certificate chain is not displayed and error is logged
66. User opens app and IndexedDB schema is checked
67. Schema migration is applied if needed
68. Data integrity is preserved after migration
69. User opens app and security headers are present in HTTP response
70. CSP is enforced and unsafe-inline is minimized
71. CSP violation occurs and is logged to reporting endpoint
72. User right-clicks message and context menu appears
73. User selects Delete for me and message is deleted for current user only
74. User selects Pin for me and message is pinned for current user only
75. User opens Pin Management Panel and sees pinned messages
76. User clicks Jump to message and chat scrolls to pinned message
77. User unpins message and pin indicator is removed
78. User replies to message and quoted preview is displayed
79. User clicks quoted preview and chat scrolls to original message
80. User marks message as View Once and sends it
81. Recipient views view-once message and it disappears immediately
82. User navigates to Contact Exchange Page and displays QR code
83. User A scans user B's QR code and both are added to each other's contact list
84. User with Keep me signed in enabled opens app and authentication page is skipped
85. User navigates to Contact Notification Settings Page and enables notifications for a contact
86. User receives generic wake-up push notification for new message from that contact
87. User unlocks app and sees new message details
88. User toggles Push Notifications button in Settings Page and preference is updated
89. User opens emoji picker and searches for emoji
90. Search returns relevant emoji results
91. User installs PWA on Windows/Desktop and shortcut icon displays correctly
92. User opens app and messages are rendered in chronological order
93. User scrolls up and messages are loaded incrementally using cursor-based pagination
94. User opens app and sees Service Worker Update Prompt when new version is available
95. User clicks Update Now and new service worker is activated
96. User sends message and KEM encryption succeeds
97. KEM fails during encryption and hard failure is triggered
98. User receives message and KEM decryption succeeds
99. KEM fails during decryption and session reset is triggered
100. Existing user with @shadowcrypt.com email logs in and email is migrated to @sylvacrypt.com
101. New user is created and email is assigned in @sylvacrypt.com format
102. Push notification is sent and push-notify Edge Function verifies contact relationship and blocklist
103. Notification is sent only if both checks pass
104. Duplicated personal_pins delete logic in dbStore is removed
105. Database operations for personal_pins function correctly without duplication
106. User navigates to Themes Page and clicks Create Custom Theme button
107. Custom Theme Editor opens with color pickers, font selector, and background image selector
108. User selects colors for message bubble, send button, background, and other UI components
109. User selects font for messages and other text
110. User selects background image from device storage
111. User attempts to save custom theme without naming it
112. Error message is displayed: Theme must be named before saving
113. User names custom theme and clicks Save as Private
114. Custom theme is saved as private and appears in user's custom theme list
115. User applies private custom theme and all selected colors, font, and background image are rendered correctly
116. User edits existing custom theme and changes are saved immediately
117. User toggles custom theme privacy status from Private to Public
118. Custom theme becomes visible and usable by all users
119. User navigates to Privacy Policy and Terms of Service Page
120. Page displays complete privacy policy and terms of service text
121. Page includes Custom Theme Background Image Usage Guidelines section
122. Guidelines state criteria for acceptable background images
123. Guidelines state Public Themes standard and Right to Remove policy
124. User right-clicks message and selects React option
125. Reaction Palette opens with most frequently used emojis displayed at top
126. User selects emoji from Reaction Palette
127. Emoji reaction is added to message and displayed with count
128. User clicks their own reaction to remove it
129. Reaction is removed from message and count is updated
130. User searches for emoji in Reaction Palette
131. Search returns relevant emoji results with most frequently used emojis still at top

## 7. Out of Scope for This Release

- Voice or video calling
- File sharing or media attachments
- Message editing or deletion after sending
- Multi-device synchronization (beyond pin sync)
- User profile customization (avatar, bio)
- Message search functionality
- Message reactions or emoji responses (now in scope)
- Read receipts beyond delivery status
- Typing indicators
- Screenshot prevention
- Backup and restore of local encrypted data
- Desktop or mobile native applications (web-only for this release)
- VPN usage beyond 30 minutes per day
- VPN usage tracking across multiple devices
- Customizable auto-delete timeframe (fixed at 30 days)
- Recovery of auto-deleted messages
- Customizable theme colors or fonts beyond provided themes (now in scope via Custom Theme feature)
- Animated theme transitions
- Message forwarding
- Group admin roles and permissions
- Contact management features (edit, delete, block)
- Message delivery reports beyond basic delivery status
- Custom notification sounds
- In-app notification settings panel (beyond Contact Notification Settings Page)
- Automatic moderation of custom theme background images (manual review only)
- Custom theme sharing via direct link
- Custom theme rating or feedback system

## 8. Implementation Report and Roadmap

### 8.1 Implementation Report Requirement

A detailed report must be produced documenting:
- All features implemented in v6.0.0
- Technical achievements and milestones
- Known issues and limitations
- Performance metrics and improvements
- Security enhancements and audit results
- User feedback and adoption statistics
- Automated test coverage statistics

### 8.2 Future Implementation Roadmap Requirement

A detailed roadmap must be produced outlining:
- Planned features for upcoming releases (v6.1.x, v6.2.x, v7.0.x)
- Technical debt and refactoring priorities
- Security and compliance initiatives
- Performance optimization goals
- User experience improvements
- Platform expansion plans (mobile native apps, desktop apps)
- Integration with third-party services
- Scalability and infrastructure upgrades
- Timeline and resource allocation for each initiative

### 8.3 Automated Testing Expansion

- Increase automated test coverage across all modules
- Prioritize testing for:
  - Message encryption and decryption
  - Certificate chain validation
  - Push notification delivery with contact relationship and blocklist verification
  - Contact exchange flow
  - Pin message functionality with real-time sync
  - View-once message behavior with sender notification
  - Authentication and session management
  - PWA installation and offline functionality
  - VPN connection and usage tracking
  - Cursor-based message pagination
  - Service worker update flow
  - Lazy loading of QR scanner and image preview
  - Message action functionality (delete for me, pin for me, pin for everyone) on own messages
  - Theme selection and persistence (including Mint, Mint Dark, Warm Paper, and Neon Noir themes)
  - Theme application and rendering across all UI components
  - Push notification permission dialog flow
  - Push Notifications toggle button functionality in Settings Page
  - Email format migration from @shadowcrypt.com to @sylvacrypt.com
  - KEM failure handling with hard failure or session reset
  - Database store cleanup for personal_pins delete logic
  - Recovery phrase KDF migration from PBKDF2 to Argon2id
  - Self-destructing / disappearing messages with TTL
  - Password breach checking during registration and password changes
  - E2EE push notification payload decryption
  - Lazy-loaded crypto/chat/settings routes
  - Code-splitting per route
  - Crypto Worker for crypto operations
  - Keyboard shortcuts functionality
  - Theme auto-scheduling
  - Reduced-motion support
  - Message ordering fixes
  - IndexedDB schema versioning and migration
  - Security headers and CSP
  - Offline outbox queue
  - Custom theme creation, editing, and deletion
  - Custom theme privacy status toggling
  - Custom theme background image selection and validation
  - Reaction Palette functionality with frequently used emojis at top
  - Message reaction addition and removal
- Implement end-to-end tests for critical user flows
- Add regression tests for previously identified bugs
- Establish continuous integration pipeline for automated testing
- Add pnpm test step to CI GitHub Actions YAML file to run automated tests on every commit

## 9. Technical Configuration Requirements

### 9.1 Version Management
- Update semantic version to v6.0.0 across all codebase files
- Ensure version consistency in:
  - package.json
  - manifest.json
  - About page or version display UI
  - API version headers
  - Documentation files

### 9.2 Build Configuration
- Adjust Vite chunk size limit to suppress warnings for chunks exceeding 500KB
- Configure build output to optimize chunk splitting
- Ensure build warnings do not block deployment pipeline
- Fix TypeScript errors:
  - TS6133 in PushNotificationPrompt.tsx
  - TS2304 in relay.ts
- Resolve Vite dynamic-import warnings by ensuring modules are imported either statically or dynamically, not both
- Configure code-splitting per route to reduce main bundle size to under 1 MB gzipped

### 9.3 PWA Manifest Configuration
- Update manifest.json with correct icon paths and sizes for Windows/Desktop
- Ensure icon references include all required sizes (e.g., 192x192, 512x512)
- Verify icon file formats are supported by target platforms
- Test desktop shortcut icon display on Windows to confirm correct rendering

### 9.4 Application URL Configuration
- Set VITE_APP_URL to https://sylvacrypt.vercel.app/
- Ensure all environment variables are correctly configured for production deployment

### 9.5 Theme Implementation Requirements
- Ensure all theme stylesheets (Light, Dark, Mint, Mint Dark, Warm Paper, Neon Noir) are correctly loaded and applied
- Verify CSS class names and selectors for each theme are correctly defined
- Ensure theme styles have sufficient CSS specificity to override default styles
- Test theme application across all UI components to confirm correct rendering
- Verify theme persistence mechanism in local storage is functioning correctly
- Ensure theme loading on app startup occurs before UI rendering to prevent flash of unstyled content
- Implement Warm Paper theme with specified color values
- Implement Neon Noir theme with specified color values

### 9.6 Custom Theme Implementation Requirements
- Implement Custom Theme Editor UI with color pickers, font selector, and background image selector
- Implement backend storage for public custom themes
- Implement validation logic for custom theme background images based on usage guidelines
- Implement privacy status toggling for custom themes
- Ensure custom theme styles are dynamically generated and applied to all UI components
- Implement draft saving mechanism for unnamed custom themes
- Implement custom theme deletion functionality

### 9.7 Database Migration Requirements
- Execute database migration script to update all existing user email formats from @shadowcrypt.com to @sylvacrypt.com
- Update user creation logic to assign @sylvacrypt.com email format directly for all new users
- Verify migration completion and data integrity after migration
- Ensure backward compatibility during migration period if necessary

### 9.8 Push Notification Security Requirements
- Update push-notify Edge Function to include security checks before sending notifications:
  - Verify contact relationship exists between sender and recipient
  - Verify recipient has not blocked the sender
  - Only send push notification if both checks pass
- Implement structured logging for security check failures
- Add monitoring and alerting for unauthorized notification attempts

### 9.9 CI/CD Pipeline Requirements
- Add pnpm test step to GitHub Actions CI workflow YAML file
- Ensure automated tests run on every commit to main branch and pull requests
- Configure test failure to block merge/deployment
- Set up test coverage reporting in CI pipeline

### 9.10 KEM Failure Handling Requirements
- Update encryption/decryption logic to trigger hard failure or session reset on KEM failure
- Remove silent classical fallback mechanism
- Implement error logging and user notification for KEM failures
- Ensure session state is properly reset after KEM failure

### 9.11 Database Store Cleanup Requirements
- Remove duplicated personal_pins delete logic in dbStore
- Ensure single, clean implementation of personal_pins delete functionality
- Verify database operations function correctly after cleanup
- Add unit tests to prevent future duplication

### 9.12 Recovery Phrase KDF Migration Requirements
- Implement transparent migration from PBKDF2 to Argon2id for recovery phrase hash
- Detect legacy PBKDF2 hashes on unlock and re-hash using Argon2id
- Store migration status in IndexedDB
- Ensure new recovery phrases use Argon2id directly

### 9.13 Self-Destructing Messages Requirements
- Implement TTL selector in message input area
- Add countdown timer display for disappearing messages
- Implement client-side and server-side deletion after TTL expires
- Ensure disappearing messages cannot be pinned or replied to after expiration

### 9.14 Password Breach Checking Requirements
- Integrate Have I Been Pwned API using k-anonymity model
- Implement server-side breach check during registration and password changes
- Display warning to user if password is found in breach database
- Allow user to override warning and proceed (not recommended)

### 9.15 E2EE Push Notification Payload Requirements
- Implement full E2EE for push notification payloads
- Ensure server only sees ciphertext
- Implement client-side decryption of notification title and body
- Offload decryption to Crypto Worker
- Display generic notification if decryption fails

### 9.16 Lazy Loading and Code Splitting Requirements
- Implement lazy loading for crypto/chat/settings routes
- Configure Vite to split code per route
- Ensure main bundle size is under 1 MB gzipped
- Resolve dynamic-import warnings

### 9.17 Crypto Worker Requirements
- Implement Web Worker for all cryptographic operations
- Offload encryption/decryption to background thread
- Implement message passing between main thread and worker
- Ensure UI remains responsive during crypto operations

### 9.18 Keyboard Shortcuts Requirements
- Implement extensive keyboard shortcuts for navigation and actions
- Display all shortcuts in Keyboard Shortcuts Section of Settings Page
- Allow users to customize shortcuts
- Save shortcuts in local storage

### 9.19 Theme Auto-Scheduling Requirements
- Implement theme auto-scheduling based on time of day
- Allow users to customize time ranges for auto-switching
- Disable auto-scheduling when user manually changes theme
- Save auto-scheduling preference in local storage

### 9.20 Reduced Motion Requirements
- Honor prefers-reduced-motion media query
- Disable or simplify animations when reduced motion is preferred
- Allow users to manually toggle reduced-motion support
- Save reduced-motion preference in local storage

### 9.21 Message Ordering Requirements
- Ensure messages are always rendered in chronological order
- Use server timestamp as primary ordering key
- Re-sort out-of-order messages automatically upon receipt

### 9.22 IndexedDB Schema Versioning Requirements
- Implement robust schema versioning system
- Create migration harness for schema upgrades
- Track schema version in IndexedDB
- Apply migrations sequentially
- Handle migration failures gracefully

### 9.23 Security Headers and CSP Requirements
- Configure security headers in Nginx:
  - X-Content-Type-Options: nosniff
  - X-Frame-Options: DENY
  - X-XSS-Protection: 1; mode=block
  - Strict-Transport-Security: max-age=31536000; includeSubDomains
  - Referrer-Policy: no-referrer
- Implement CSP with nonces/hashes to reduce unsafe-inline reliance
- Configure CSP reporting endpoint
- Log and monitor CSP violations

### 9.24 Offline Outbox Queue Requirements
- Implement offline outbox queue in IndexedDB
- Queue messages sent while disconnected
- Automatically send queued messages when connection is restored
- Display pending messages with sending status indicator
- Allow users to retry or delete failed messages

### 9.25 Reaction Palette Requirements
- Implement Reaction Palette UI with emoji picker
- Display most frequently used emojis at top of palette
- Implement emoji search functionality in Reaction Palette
- Track emoji usage frequency per user
- Update frequently used emojis list dynamically based on usage

### 9.26 Privacy Policy and Terms of Service Page Requirements
- Update page title from Privacy Policy to Privacy Policy and Terms of Service
- Add Custom Theme Background Image Usage Guidelines section
- Include criteria for acceptable background images
- Include Public Themes standard and Right to Remove policy
- Ensure page content is accessible and scrollable