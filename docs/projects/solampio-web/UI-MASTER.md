# Solampio Web - UI Master Document

**Project:** solampio-web
**Repository:** /home/chris/projects/solampio-web
**Stack:** Qwik + Tailwind + DaisyUI + Cloudflare Pages
**Last Updated:** 2024-12-20

---

## Architecture Overview

| Layer | Service | Status | Notes |
|-------|---------|--------|-------|
| **Frontend** | Qwik + Cloudflare Pages | Active | This project |
| **CMS** | Strapi | Running (GCP) | Consider migration to Cloudflare |
| **Auth** | Separate OAuth layer | Planned | Google, GitHub, etc. providers |
| **ERP/Backend** | ERPNext on Frappe Cloud | Working | API needs testing/new key |
| **Media** | Cloudflare Images | Planned | All product/content images |
| **Current Data** | BigCommerce | Migration source | Phase 5 |

---

## Implementation Phases

### Phase 1: Frontend UI Skeleton (CURRENT)
Build all pages with localStorage/mock data. Focus on UX, not backend integration.

### Phase 2: Strapi Integration + Hosting
- Connect CMS content to frontend
- Evaluate Strapi on Cloudflare Workers/D1 compatibility
- Decision: Keep on GCP or migrate?

### Phase 3: Auth Layer
- OAuth providers (Google, GitHub, etc.)
- Secure middleware between user and data
- Session management

### Phase 4: ERPNext Integration
- Test/refresh API access (get new key)
- Connect real product/inventory/order data
- Customer account sync

### Phase 5: BigCommerce Migration
- Export BC data
- Transform/clean data
- Load to ERPNext

---

## Site Structure

### Completed Pages

| Route | Description | Status |
|-------|-------------|--------|
| `/` | Homepage | Done |
| `/products/` | Product catalog main | Done |
| `/products/[slug]/` | Product detail page | Done |
| `/products/category/[category]/` | Category listing | Done |
| `/products/category/[category]/[subcategory]/` | Subcategory listing | Done |
| `/products/brand/[brand]/` | Brand listing | Done |
| `/about/` | About page | Basic |
| `/contact/` | Contact page | Basic |
| `/learn/` | Learn section landing | Basic |
| `/learn/courses/` | Courses listing | Basic |
| `/docs/` | Documentation landing | Basic |

### Skeleton Pages Needed

#### Customer Portal
| Route | Description | Priority |
|-------|-------------|----------|
| `/account/` | Account dashboard | High |
| `/account/profile/` | User profile | High |
| `/account/orders/` | Order history | High |
| `/account/orders/[id]/` | Order detail + tracking | High |
| `/account/quotes/` | Quote requests | High |
| `/account/quotes/[id]/` | Quote detail | High |
| `/account/saved-carts/` | Saved shopping carts | Medium |
| `/account/settings/` | Account settings | Medium |
| `/login/` | Login page | High |
| `/register/` | Registration page | High |

#### Shopping/Quotes
| Route | Description | Priority |
|-------|-------------|----------|
| `/cart/` | Shopping cart | High |
| `/checkout/` | Checkout flow | High |
| `/quote-request/` | Request quote form | High |

#### Learn Section
| Route | Description | Priority |
|-------|-------------|----------|
| `/learn/` | Learn hub landing | Done (needs enhancement) |
| `/learn/courses/` | Moodle courses (via learn.solampio.com) | High |
| `/learn/courses/[slug]/` | Course detail/embed | High |
| `/learn/articles/` | Educational articles (info.solampio.com) | High |
| `/learn/articles/[slug]/` | Article detail | High |
| `/learn/blog/` | Blog (solampio.com) | High |
| `/learn/blog/[slug]/` | Blog post detail | High |

#### Document Library
| Route | Description | Priority |
|-------|-------------|----------|
| `/docs/` | Document library hub | High |
| `/docs/category/[category]/` | Doc category listing | Medium |
| `/docs/[slug]/` | Document detail/download | Medium |

#### Base/Static Pages
| Route | Description | Priority |
|-------|-------------|----------|
| `/terms/` | Terms & Conditions | High |
| `/privacy/` | Privacy Policy | High |
| `/shipping/` | Shipping Information | Medium |
| `/returns/` | Returns Policy | Medium |
| `/warranty/` | Warranty Information | Medium |
| `/faq/` | FAQ page | Medium |

---

## External Services Integration

### Moodle (learn.solampio.com)
- Courses and training materials
- Consider iframe embed or API integration
- SSO with main auth layer

### Info Site (info.solampio.com)
- Educational articles
- May migrate content to Strapi
- Or API pull from existing

### Blog (solampio.com)
- Company blog
- Migrate to Strapi or keep separate?
- Content sync strategy needed

### Document Library (Dropbox)
- Product datasheets, manuals, specs
- Migration to Cloudflare R2 or keep Dropbox?
- Access control considerations

---

## Component Library

### Existing Components
- `Header` - Main navigation
- `Footer` - Site footer
- `ProductSidebar` - Category/brand navigation (products section)

### Needed Components
- `CartDrawer` - Slide-out cart
- `QuoteButton` - Add to quote CTA
- `AccountNav` - Account section navigation
- `OrderCard` - Order summary card
- `TrackingStatus` - Order tracking display
- `DocumentCard` - Document library item
- `CourseCard` - Course preview card
- `ArticleCard` - Article preview card
- `BasePage` - Template for static content pages
- `AuthModal` - Login/register modal
- `SearchModal` - Global search overlay

---

## Design System

### Colors (from tailwind.config.js)
- Forest Green: `#042e0d` (primary)
- Bright Green: `#56c270` (accent/success)
- Gold: `#c3a859` (secondary/highlight)
- Blue: `#5974c3` (info/links)
- Light Gray: `#f1f1f2` (backgrounds)

### Typography
- Headings: `font-heading` (extrabold)
- Body: Default sans
- Mono: `font-mono` (specs, codes)

### Patterns
- Cards with border + hover shadow
- Sticky filter bars
- Breadcrumb navigation
- CTA sections with dark background

---

## Data Models (Frontend/localStorage)

### Cart Item
```typescript
interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  price: string; // "Call for Pricing" or actual
  image?: string;
  specs?: string;
}
```

### Quote Request
```typescript
interface QuoteRequest {
  id: string;
  items: CartItem[];
  status: 'pending' | 'quoted' | 'accepted' | 'expired';
  createdAt: string;
  quotedPrice?: number;
  validUntil?: string;
  notes?: string;
}
```

### Order
```typescript
interface Order {
  id: string;
  items: CartItem[];
  status: 'pending' | 'processing' | 'shipped' | 'delivered';
  createdAt: string;
  trackingNumber?: string;
  carrier?: string;
  total?: number;
  shippingAddress: Address;
}
```

### User
```typescript
interface User {
  id: string;
  email: string;
  name: string;
  company?: string;
  phone?: string;
  addresses: Address[];
  defaultAddressId?: string;
}
```

---

## Notes & Decisions

### Strapi Hosting Decision
- Currently on GCP
- Evaluate Cloudflare Workers compatibility
- Consider: latency, cost, maintenance
- **Action:** Research before Phase 2

### Auth Strategy
- Separate auth layer (not ERPNext users directly)
- OAuth providers: Google, GitHub (more to add)
- Link auth accounts to ERPNext customer records
- Benefits: security layer, better UX, adoption rates

### Quote-Based Pricing
- Most products are "Call for Pricing"
- Quote system is primary, direct purchase secondary
- Hybrid model: some items purchasable, most quote-only

---

## Related Resources

- [ERPNext API Docs](https://frappeframework.com/docs/user/en/api)
- [Strapi Docs](https://docs.strapi.io/)
- [Qwik Docs](https://qwik.dev/)
- [Cloudflare Pages](https://developers.cloudflare.com/pages/)

---

## Changelog

### 2024-12-20
- Initial document creation
- Documented current state and phase plan
- Added skeleton page requirements
- Added customer portal requirements
- Added learn section requirements (Moodle, articles, blog)
- Added document library requirements
- Added base page template needs
