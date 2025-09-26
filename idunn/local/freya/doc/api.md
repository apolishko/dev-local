## Table of Contents

- [HTTP Odin/Baldr ACCESS](#http-odinbaldr-access)
- [ASYNC Generator Access (RabbitMQ)](#async-generator-access-rabbitmq)
- [AssetSchema](#assetschema)
    - [Example](#example)
    - [Field Overview](#field-overview)
    - [AssetSchema CRUD](#assetschema-crud)
- [Asset](#asset)
    - [Example](#example-1)
    - [Field Overview](#field-overview-1)
    - [Asset CRUD](#asset-crud)
- [Upload Flow](#upload-flow)
    - [Request Upload Links](#1-request-upload)
    - [Uploading Files (PUT)](#2-uploading-files-put)
- [Search API](#search-api)
    - [Endpoints](#endpoints)
    - [Request Format](#request-format)
    - [Supported Operators](#supported-operators)
- [Reverse Proxy](#reverse-proxy)

## HTTP Odin/Baldr ACCESS

**AMS** (aka **Freya**) is designed to run behind a _reverse proxy_.  
It does not handle authentication or user session management directly.

Instead, it expects the following HTTP headers to be injected by an upstream service - **Odin**:

- `x-tenant-id`: unique identifier of the tenant [TODO: or x-tenant-name]
- `x-user-email`: email of the authenticated user making the request

## ASYNC Generator Access (RabbitMQ)

This service also supports direct access via RabbitMQ for integration with the **Generator** service.  
Unlike HTTP, RabbitMQ access bypasses the reverse proxy and does **not** include tenant or user context.  
It is assumed to be trusted and isolated.

#### Notes

- No authentication or authorization is applied at this level.
- The consumer is expected to know what it’s doing.
- All calls operate directly on the underlying database, without tenant isolation.

## AssetSchema

The `AssetSchema` (_aka Resource Schema_) defines the structure of an asset type — what input files are expected, which
variations can be
generated, and what rules apply to each part.  
It is used during asset creation, upload, validation, and processing.

This schema is stored in the database and can be edited by developers or admins.  
It is referenced by actual asset records to ensure they follow the correct format.

**Global Nature**: Asset schemas are global resources shared across all tenants:

- All schemas are accessible by any tenant - they define shared contracts for asset types
- No tenant isolation is applied to schemas - they are infrastructure-level resources
- Schemas are hardcoded contracts used by neighboring projects and should be consistent across all tenants

#### Example

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "type": "image",
  "description": "High-resolution image with multiple scaled variations for different display contexts",
  "group": "image",
  "tags": [
    "image",
    "media",
    "high-res"
  ],
  "version": "1.0.0",
  "status": "PUBLISHED",
  "schema": {
    "inputs": [
      {
        "id": "master",
        "description": "High-resolution master image file",
        "required": true,
        "isMaster": true,
        "isPreview": false,
        "allowedMimeTypes": [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/tiff",
          "image/bmp"
        ],
        "tags": [
          "master",
          "source",
          "image"
        ],
        "constraints": [
          {
            "property": "width",
            "min": 150
          },
          {
            "property": "height",
            "min": 150
          }
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true
          },
          {
            "name": "height",
            "type": "number",
            "required": true
          }
        ]
      }
    ],
    "variations": [
      {
        "id": "1080h",
        "description": "1080px height scaled down image in AVIF format for desktop displays",
        "allowedMimeTypes": [
          "image/avif"
        ],
        "required": true,
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "isPreview": false,
        "tags": [
          "scaled",
          "1080p"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true
          },
          {
            "name": "height",
            "type": "number",
            "required": true
          },
          {
            "name": "aspectRatio",
            "type": "number",
            "required": true
          }
        ]
      },
      {
        "id": "720h",
        "description": "720px height scaled down image in AVIF format for tablet displays",
        "allowedMimeTypes": [
          "image/avif"
        ],
        "required": true,
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "isPreview": false,
        "tags": [
          "scaled",
          "720p"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true
          },
          {
            "name": "height",
            "type": "number",
            "required": true
          },
          {
            "name": "aspectRatio",
            "type": "number",
            "required": true
          }
        ]
      },
      {
        "id": "480h",
        "description": "480px height scaled down image in AVIF format for mobile displays",
        "allowedMimeTypes": [
          "image/avif"
        ],
        "required": true,
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "isPreview": false,
        "tags": [
          "scaled",
          "480p"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true
          },
          {
            "name": "height",
            "type": "number",
            "required": true
          },
          {
            "name": "aspectRatio",
            "type": "number",
            "required": true
          }
        ]
      },
      {
        "id": "150h",
        "description": "150px height thumbnail in AVIF format for NodeGraphEditor preview",
        "allowedMimeTypes": [
          "image/avif"
        ],
        "required": false,
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "isPreview": false,
        "tags": [
          "thumbnail",
          "node-editor",
          "avif"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true
          },
          {
            "name": "height",
            "type": "number",
            "required": true
          },
          {
            "name": "aspectRatio",
            "type": "number",
            "required": true
          }
        ]
      },
      {
        "id": "previewImage",
        "description": "Preview image for user display (optional, only for specific nodes)",
        "allowedMimeTypes": [
          "image/avif",
          "image/webp"
        ],
        "required": false,
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "isPreview": true,
        "tags": [
          "preview"
        ]
      }
    ]
  },
  "createdBy": "user@indg.com",
  "createdAt": "2025-05-15T12:00:00Z",
  "lastModifiedAt": "2025-05-16T09:42:00Z",
  "lastModifiedBy": "user-2@indg.com"
}
```

---

#### Field Overview

- `id`: UUID (auto generated, e.g., "550e8400-e29b-41d4-a716-446655440001")
- `type`: (aka slug) short string used as identifier (URL-safe), _can be used as shortcuts/hardcoded in the Generator
  Node Graph Editor_
- `description`: human-readable explanation of the schema
- `group`: asset schema group (e.g. image, video)
- `tags`: optional labels for categorization or automation
- `version`: semver string for tracking schema versions [TODO: might be handy for migrations and upgrades]
- `status`: lifecycle state (`DRAFT`, `PUBLISHED`, `ARCHIVED`) [TODO: is it needed for MVP ???]
- `schema.inputs[]`: array of expected input files with MIME types, constraints, and property definitions
- `schema.inputs[].required`: boolean indicating if the input is required (defaults to true)
- `schema.inputs[].isPreview`: boolean indicating if this input should be used for preview (optional, max 1 per schema)
- `schema.variations[]`: array of defined output variations with allowed MIME types (can be auto-generated or uploaded
  manually)
- `schema.variations[].required`: boolean indicating if the variation is required (defaults to true)
- `schema.variations[].isPreview`: boolean indicating if this variation should be used for preview (optional, max 1 per
  schema)
- `schema.variations[].description`: optional human-readable description of the variation
- `schema.variations[].allowedMimeTypes[]`: array of allowed MIME types for this variation (
  e.g., ["image/webp", "image/jpeg"])
- `schema.inputs[].constraints[]`: array of validation constraints for file properties (width, height, etc.)
- `schema.inputs[].properties[]`: array of structured property definitions that describe expected file metadata (must
  use known property names)
- `schema.variations[].properties[]`: array of structured property definitions for variation outputs (must use known
  property names)
- `createdBy`: user who created the schema (optional)
- `createdAt`: ISO 8601 timestamp
- `lastModifiedAt`: ISO 8601 timestamp when schema was last modified
- `lastModifiedBy`: user who last modified the schema

#### Property Definition Constraints

**Important**: The `properties[]` arrays in both inputs and variations must use property names from a predefined list of
known property names:

- `width` - Image width in pixels (number)
- `height` - Image height in pixels (number)
- `colorDepth` - Color depth in bits (number)
- `aspectRatio` - Aspect ratio as width/height (number)
- `colorSpace` - Color space name like sRGB (string)
- `hasAlpha` - Whether image has transparency (boolean)

Custom property names are **not allowed** and will cause validation errors.

#### Preview Validation Rule

**Important**: A schema can have **at most one** preview item across all inputs and variations combined. This means:

- You can mark one input as `isPreview: true` OR one variation as `isPreview: true`
- You cannot have multiple preview items in the same schema
- Having zero preview items is allowed

This validation ensures there's no ambiguity about which item should be used for preview purposes.

---

## AssetSchema CRUD

The following endpoints allow full management of asset schemas.  
Only admins or authorized users should be allowed to modify schemas.

#### Create AssetSchema

```
POST /schemas
```

**Body:**

```json
{
  "type": "image",
  "description": "High-resolution image with multiple scaled variations for different display contexts",
  "group": "image",
  "tags": [
    "image",
    "media",
    "high-res"
  ],
  "version": "1.0.0",
  "status": "DRAFT",
  "schema": {
    "inputs": [
      {
        "id": "master",
        "description": "Main banner image",
        "required": true,
        "isMaster": true,
        "allowedMimeTypes": [
          "image/png",
          "image/jpeg"
        ],
        "tags": [
          "main",
          "source"
        ],
        "constraints": [
          {
            "property": "width",
            "min": 100,
            "max": 4000
          },
          {
            "property": "height",
            "min": 100,
            "max": 3000
          }
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true,
            "description": "Image width in pixels"
          },
          {
            "name": "height",
            "type": "number",
            "required": true,
            "description": "Image height in pixels"
          }
        ]
      },
      {
        "id": "logo",
        "description": "Brand logo overlay",
        "required": false,
        "allowedMimeTypes": [
          "image/svg+xml",
          "image/png"
        ],
        "tags": [
          "branding",
          "optional"
        ]
      }
    ],
    "variations": [
      {
        "id": "1080_avif",
        "required": true,
        "allowedMimeTypes": [
          "image/avif",
          "image/webp"
        ],
        "autogen": false,
        "sourceInputIds": [
          "master"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true,
            "description": "Generated image width"
          },
          {
            "name": "height",
            "type": "number",
            "required": true,
            "description": "Generated image height"
          }
        ],
        "tags": [
          "desktop",
          "retina"
        ]
      },
      {
        "id": "720_avif_mobile",
        "required": false,
        "isPreview": true,
        "allowedMimeTypes": [
          "image/avif",
          "image/webp"
        ],
        "autogen": false,
        "sourceInputIds": [
          "master",
          "logo"
        ],
        "properties": [
          {
            "name": "width",
            "type": "number",
            "required": true,
            "description": "Generated mobile image width"
          }
        ],
        "tags": [
          "mobile",
          "performance",
          "composite"
        ]
      }
    ]
  }
}
```

**Response:** `201 Created`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "...": "more fields here",
  "type": "image"
}
```

Returns full [AssetSchema](#assetschema).

---

#### Get by ID or Type

```
GET /schemas/:idOrType
```

If the type is used, it must be **unique**.

**Response:** `200 OK`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "...": "more fields here",
  "type": "image"
}
```

Returns full [AssetSchema](#assetschema).

---

#### Update AssetSchema

```
PUT /schemas/:id
```

Updates an existing schema.

**Body:**

```json
{
  "description": "Updated desc",
  "...": "more fields here",
  "status": "PUBLISHED"
}
```

**Response:** `200 OK`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "...": "more fields here",
  "type": "image"
}
```

Returns full [AssetSchema](#assetschema).

---

#### Delete AssetSchema

```
DELETE /schemas/:id
```

**Response:** `204 No Content`

**[TODO: do we really need to delete/soft-delete/whatever?]**

## Asset

The `Asset` (_aka File aka Resource_) entity represents a specific instance of an asset uploaded or generated within the
system.  
Each asset is based on a predefined `AssetSchema` and contains metadata, file references, and processing status.

#### Example

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "tenant": "indg",
  "schemaType": "image",
  "schema": {
    "...": "schema fields here"
  },
  "group": "image",
  "description": "High-resolution product image with multiple scaled variations",
  "tags": [
    "generator_template_id:7ec1e0d3-71a4-4232-90dc-9a0b79c548ba"
  ],
  "files": {
    "inputs": [
      {
        "id": "master",
        "url": "https://.../assets/6653ac87e118f3001224b09e/master.png",
        "mimeType": "image/png",
        "sizeBytes": 2345898,
        "isMaster": true,
        "autogen": false,
        "isPreview": false,
        "required": true,
        "properties": {
          "width": 1920,
          "height": 1080
        }
      }
    ],
    "variations": [
      {
        "id": "1080h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/1080h.avif",
        "mimeType": "image/avif",
        "sizeBytes": 342195,
        "isMaster": false,
        "autogen": false,
        "isPreview": false,
        "required": true,
        "properties": {
          "width": 1920,
          "height": 1080,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "720h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/720h.avif",
        "mimeType": "image/avif",
        "sizeBytes": 221503,
        "isMaster": false,
        "autogen": false,
        "isPreview": false,
        "required": true,
        "properties": {
          "width": 1280,
          "height": 720,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "480h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/480h.avif",
        "mimeType": "image/avif",
        "sizeBytes": 98756,
        "isMaster": false,
        "autogen": false,
        "isPreview": false,
        "required": true,
        "properties": {
          "width": 853,
          "height": 480,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "previewImage",
        "url": "https://.../assets/6653ac87e118f3001224b09e/preview.avif",
        "mimeType": "image/avif",
        "sizeBytes": 45123,
        "isMaster": false,
        "autogen": false,
        "isPreview": true,
        "required": false,
        "properties": {
          "width": 512,
          "height": 288
        }
      }
    ]
  },
  "status": "READY",
  "createdBy": "user-0@indg.com",
  "createdAt": "2025-06-19T12:00:00Z",
  "lastModifiedAt": "2025-06-19T13:15:00Z",
  "lastModifiedBy": "user-1@indg.com"
}
```

---

#### Field Overview

- `id`: UUID of the asset (e.g., "550e8400-e29b-41d4-a716-446655440003")
- `tenant`: optional tenant identifier
- `schemaType`: reference to the AssetSchema type (string, e.g., "image")
- `schema`: embedded snapshot of the AssetSchema (e.g. `group`, `type`, `description`, `tags`, etc.) taken at the time
  of asset creation
- `group`: asset group (image, video, etc.)
- `description`: optional human-readable description of the specific asset instance
- `tags`: array of tags (e.g. `generator_template_id:<uuid>`)
- `files.inputs[]`: array of uploaded input files with metadata and properties
- `files.variations[]`: array of generated or manually uploaded output files
- `files.inputs[].id`: identifier matching schema input ID
- `files.variations[].id`: identifier matching schema variation ID
- `files.*.isMaster`: whether this is the master/source file (boolean)
- `files.*.autogen`: whether this file was auto-generated (boolean)
- `files.*.isPreview`: whether this file is used for preview (boolean)
- `files.*.required`: whether this file is required (boolean)
- `files.*.properties`: actual file metadata (width, height, hasAlpha, etc.)
- `status`: current asset status (`READY`, `PENDING`, `PROCESSING`, `FAILED`)
- `createdBy`: user who created the asset
- `createdAt`: timestamp of asset creation
- `lastModifiedBy`: user who last modified the asset
- `lastModifiedAt`: timestamp of last modification

---

### Asset CRUD

#### Create Asset

```
POST /assets
```

**Body:**

```json
{
  "schemaType": "image",
  "group": "image",
  "description": "Product showcase image with multiple display formats",
  "tags": [
    "generator_template_id:7ec1e0d3-71a4-4232-90dc-9a0b79c548ba",
    "product",
    "showcase"
  ],
  "files": {
    "inputs": [
      {
        "id": "master",
        "url": "https://.../assets/6653ac87e118f3001224b09e/master.png",
        "properties": {
          "width": 1920,
          "height": 1080
        }
      }
    ],
    "variations": [
      {
        "id": "1080h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/1080h.avif",
        "properties": {
          "width": 1920,
          "height": 1080,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "720h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/720h.avif",
        "properties": {
          "width": 1280,
          "height": 720,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "previewImage",
        "url": "https://.../assets/6653ac87e118f3001224b09e/preview.avif",
        "properties": {
          "width": 512,
          "height": 288
        }
      }
    ]
  }
}
```

#### Notes

- `url` values must come from the [Upload Flow](#upload-flow) step. After the asset is created, the same URLs (or
  re-signed versions) may be reused for downstream access (e.g. image delivery).
- All files must be already uploaded to the provided SAS URLs before this call.
- You can and actually should set desired tags (i.e. creating an asset from a known generator template).
- Fields like `mimeType`, `isMaster`, `autogen`, `isPreview`, and `required` will be inferred automatically during validation.
- **File Properties**: You can optionally provide file metadata in the `properties` field (width, height, hasAlpha,
  etc.)

**Response:** `201 CREATED`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "...": "more fields here",
  "lastModifiedBy": "user-1@indg.com"
}
```

Returns full [Asset](#asset).

---

#### Get Asset

```
GET /assets/:id
```

**Response:** `200 OK`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "...": "more fields here",
  "lastModifiedBy": "user-1@indg.com"
}
```

Returns full [Asset](#asset).

---

#### Update Asset

**[TODO: IS IT ALLOWED?]**

```
PUT /assets/:id
```

```json
{
  "group": "image",
  "description": "Updated product image with enhanced variations",
  "tags": [
    "generator_template_id:7ec1e0d3-71a4-4232-90dc-9a0b79c548ba",
    "product",
    "updated"
  ],
  "files": {
    "inputs": [
      {
        "id": "master",
        "url": "https://.../assets/6653ac87e118f3001224b09e/master.png",
        "properties": {
          "width": 1920,
          "height": 1080
        }
      }
    ],
    "variations": [
      {
        "id": "1080h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/1080h.avif",
        "properties": {
          "width": 1920,
          "height": 1080,
          "aspectRatio": 1.777777778
        }
      },
      {
        "id": "480h",
        "url": "https://.../assets/6653ac87e118f3001224b09e/480h.avif",
        "properties": {
          "width": 853,
          "height": 480,
          "aspectRatio": 1.777777778
        }
      }
    ]
  }
}
```

**Response:** `200 OK`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "...": "more fields here",
  "lastModifiedBy": "user-1@indg.com"
}
```

Returns full [Asset](#asset).

---

#### Delete Asset

**[TODO: IS IT ALLOWED?]**

```
DELETE /assets/:id
```

**Response:** `204 No Content`

## Upload Flow

#### UI Implementation Notes

- You should be aware of predefined AssetSchema.type values, and associate them with supported upload use-cases (e.g.
  font, video, etc.). See [AssetSchema](#assetschema) for details.

- Use this information to dynamically generate a modal or in-place UI component for file upload.

- For each inputs/variations entry:

    - Display label (description) and constraints

    - Mark required vs optional

    - Enforce allowed MIME types (from `allowedMimeTypes[]` arrays) before upload

- When starting the upload flow, the UI triggers POST `/schemas/:idOrType/request-upload`, and receives back the
  structure of urls to be uploaded.

### 1. Request Upload

```
POST /schemas/:idOrType/request-upload
```

#### Response

```json
{
  "schemaType": "image",
  "schema": {
    "...": "schema fields here"
  },
  "uploadUrls": {
    "inputs": [
      {
        "id": "master",
        "url": "https://.../master.png?..."
      }
    ],
    "variations": [
      {
        "id": "1080h",
        "url": "https://.../1080h.avif?..."
      },
      {
        "id": "720h",
        "url": "https://.../720h.avif?..."
      },
      {
        "id": "480h",
        "url": "https://.../480h.avif?..."
      },
      {
        "id": "150h",
        "url": "https://.../150h.avif?..."
      },
      {
        "id": "previewImage",
        "url": "https://.../preview.avif?..."
      }
    ]
  }
}
```

- You will receive SAS-signed Azure Blob URLs for all expected `inputs` and `variations` as defined in the`AssetSchema`.
- `schema` and `schemaType` used for validation of inputs and for further Asset creation
- `uploadUrls.inputs[]` — array of upload URLs for input files defined in `schema.inputs[]`, each with `id` and `url`
- `uploadUrls.variations[]` — array of upload URLs for variations defined in `schema.variations[]`, each with `id` and
  `url`
    - Only included if manual upload is expected (e.g. `autogen: false`)
    - Files uploaded to these URLs must match one of the MIME types in the variation's `allowedMimeTypes[]` array

### 2. Uploading Files (PUT)

Each link is a direct Azure Blob SAS URL.  
To upload a file, send an HTTP PUT with the proper `Content-Type`:

```
PUT https://.../1080h.avif?...
Content-Type: image/avif

<binary file>
```

Requirements:

- **For inputs**: File must match one of the MIME types in `schema.inputs[].allowedMimeTypes[]`
- **For variations**: File must match one of the MIME types in `schema.variations[].allowedMimeTypes[]`
- Use correct `Content-Type` header matching the uploaded file's MIME type

## Search API

Each entity exposes its own `/search` endpoint, which accepts a structured query object and returns matching records
with pagination.

#### Endpoints

- `POST /assets/search` — Search for uploaded assets
- `POST /schemas/search` — Search for defined schemas

These endpoints use a common query language (see below), but operate on different models and fields.

#### Request Format

Each `/search` endpoint accepts a POST body conforming to the following format:

```json
{
  "offset": 0,
  "limit": 20,
  "sort": [
    {
      "field": "createdAt",
      "dir": "DESC"
    }
  ],
  "query": {
    "logical": "and",
    "predicates": [
      {
        "field": "status",
        "operator": "equals",
        "value": "PUBLISHED"
      },
      {
        "field": "tags",
        "operator": "arrayContainsAny",
        "value": [
          "image",
          "media"
        ]
      }
    ]
  }
}
```

Response:

```json
{
  "results": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "...": "more fields here",
      "createdAt": "2025-06-18T10:30:00Z"
    }
  ],
  "total": 12,
  "offset": 0,
  "limit": 20,
  "sort": [
    {
      "field": "createdAt",
      "dir": "DESC"
    }
  ]
}
```

### Supported Operators

| Operator           | Description                                              | Example Value            |
|--------------------|----------------------------------------------------------|--------------------------|
| `equals`           | Field equals given value                                 | `"READY"`                |
| `notEquals`        | Field does not equal value                               | `"ARCHIVED"`             |
| `in`               | Field matches one of the listed values                   | `["image", "video"]`     |
| `lt`               | Less than                                                | `10`                     |
| `lte`              | Less than or equal                                       | `100`                    |
| `gt`               | Greater than                                             | `5`                      |
| `gte`              | Greater than or equal                                    | `5`                      |
| `between`          | Field is between two values (inclusive)                  | `[100, 200]`             |
| `isNull`           | Field is exactly null                                    | —                        |
| `isNotNull`        | Field is not null                                        | —                        |
| `startsWith`       | String starts with given value (case-insensitive)        | `"hero"`                 |
| `endsWith`         | String ends with given value (case-insensitive)          | `"footer"`               |
| `contains`         | Field contains substring (case-insensitive)              | `"banner"`               |
| `notContains`      | Field does **not** contain substring (case-insensitive)  | `"draft"`                |
| `arrayContainsAny` | At least one of the values is present (arrays/tags/etc.) | `["homepage", "mobile"]` |
| `arrayContainsAll` | All listed values must be present                        | `["homepage", "retina"]` |

## Reverse Proxy

#### AMS Routes to Be Proxied by Odin

| Route Pattern | Method(s) | Description                       |
|---------------|-----------|-----------------------------------|
| `/assets/*`   | ALL       | Asset creation, update, retrieval |
| `/schemas/*`  | ALL       | Schema management                 |

#### Headers (injected by Odin)

| Header         | Description                           | Example           |
|----------------|---------------------------------------|-------------------|
| `x-tenant-id`  | Unique identifier of the tenant       | `"indg"`          |
| `x-user-email` | Email of the authenticated user       | `"user@indg.com"` |
| `x-user-roles` | (Optional) User roles in the system   | `"admin,creator"` |
| `x-request-id` | (Optional) Trace/debug correlation ID | `"req-12345"`     |
