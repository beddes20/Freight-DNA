# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to empower sales representatives to efficiently build and manage organizational charts for their customer accounts, track key contacts, and monitor their reporting structures. The system also facilitates tracking of shipping lanes, managed regions, freight spend, and spot bidding processes. A significant feature set includes dedicated RFP (Request for Proposal) and Award management functionalities, supported by Excel upload and data analysis capabilities for RFPs. The application aims to streamline sales workflows, enhance customer relationship management in the transportation sector, and provide data-driven insights for sales opportunities. It incorporates robust role-based access control (RBAC) to ensure data security and appropriate access levels for admin, national account managers, and account managers. The business vision is to provide a comprehensive, intuitive tool that significantly improves sales efficiency and strategic account penetration for transportation brokers, thereby increasing market share and revenue.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes a modern, responsive design built with React, TypeScript, and Tailwind CSS, leveraging `shadcn/ui` components for a consistent and polished look. It supports both dark and light modes, with blue and green accent colors providing a distinct brand identity. The dashboard features a gradient hero banner and KPI stat cards with intuitive icons. Navigation is handled by a responsive sidebar. Interactive elements like confetti animations are used to enhance user experience during key actions.

### Technical Implementations
- **Frontend**: React with TypeScript, using TanStack Query for data fetching and Wouter for client-side routing.
- **Backend**: Express.js with TypeScript, handling API endpoints, authentication, and file processing.
- **Database**: PostgreSQL with Drizzle ORM for type-safe database interactions.
- **Authentication**: Session-based authentication using `express-session`, `connect-pg-simple` for session storage in PostgreSQL, and `bcrypt` for password hashing. Role-based access control (RBAC) is implemented across all data and functionalities, filtering visibility based on user roles (Admin, National Account Manager, Account Manager).
- **File Processing**: `xlsx` (SheetJS) is used for parsing Excel/CSV files, and `multer` for handling file uploads, particularly for RFP and financial data.
- **Mapping & Geocoding**: Leaflet (direct integration, not `react-leaflet`) is used for interactive maps, specifically for a delivery heatmap. Custom geocoding logic (`server/geocoding.ts`) with pre-stored US city/state coordinates and Haversine distance calculations supports spatial analysis.
- **Data Models**: Key entities include Users (with role and manager hierarchy), Companies (assigned to account managers), Contacts (with reporting structures, lanes, regions, freight spend), RFPs (with detailed lane analysis and status tracking), Awards, and Tasks.
- **Key Features**:
    - **Company & Contact Management**: Full CRUD operations with detailed transportation-specific fields.
    - **Organizational Chart Visualization**: Hierarchical display of contact reporting structures.
    - **RFP & Award Management**: Dedicated modules with Excel upload for analysis, including automatic extraction of high-volume lanes.
    - **Lane Research & Assignment**: Functionality to research and assign ownership for high-volume lanes identified from RFPs.
    - **Analytical Features**:
        - **Facility Coverage Gap Analysis**: Identifies uncovered facilities from RFPs compared to existing contact coverages.
        - **Lane Pattern Analysis**: Analyzes top corridors, shipping/receiving hubs, and state-to-state volume.
        - **Historical Data Analysis**: Provides insights into delivery destination frequency, "hot zones," and historical lane corridors.
        - **Top Opportunities**: An intelligent engine cross-referencing delivery destinations with RFP lane origins to identify potential sales opportunities.
        - **Proximity Matches**: Identifies delivery zones within a 75-mile radius of customer RFP pickup origins.
        - **Lane Matching Portlet**: Overlaps historical freight network data with customer RFP lanes to identify backhaul and delivery opportunities.
    - **User Management**: Admin and National Account Manager interfaces for user CRUD operations and team hierarchy management.
    - **Account Transfer**: Functionality for admins and NAMs to reassign companies to different account managers.
    - **Global Search**: A live, debounced search across companies and users.
    - **OneDrive Sync**: For financial uploads, allowing direct fetching of Excel files from a specified OneDrive share link, eliminating manual upload.
    - **Task Assignment**: Create, assign, and track tasks with status cycling (open → in_progress → completed), due dates with color-coded badges (red=overdue, amber=today, yellow=soon), link to accounts. "My Tasks" portlet on dashboard; per-account tasks portlet on company detail page.
    - **Trends / Growth / Ideas Feed**: Team communication portlet on dashboard. Users post categorized thoughts (Trend/Growth/Idea) visible to their RBAC-scoped team. Reverse-chronological feed with category badges, author attribution, relative timestamps, and delete capability.

## External Dependencies
- **PostgreSQL**: Primary database for all application data and session storage.
- **xlsx (SheetJS)**: For parsing and processing Excel/CSV file uploads.
- **multer**: Middleware for handling multi-part form data, primarily for file uploads.
- **Leaflet**: JavaScript library for interactive maps, used for visualizing delivery densities.
- **OneDrive API (Microsoft Graph API)**: Utilized for fetching Excel files from OneDrive shared links for financial data synchronization.