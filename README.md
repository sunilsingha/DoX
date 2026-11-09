# GST invoice extraction

A Fiori Horizon style page for SAP BTP Document AI. Upload a GST invoice and review the header and line items in tables. The columns come from `schema/ZSFL_GST_Invoice_schema.json`.

The export named `ZSFL_GST_Invoice_schema.json` was not in this workspace, so the schema file is a stand-in in the SAP export shape. Replace it with your export. Preview sample works before a service key is configured and does not call BTP.

## 1. Service instance

In the subaccount where you subscribed to Document AI:

1. Open Instances and Subscriptions.
2. Create a service instance of Document Information Extraction (the runtime behind Document AI) if you do not already have one.
3. Create a service key and open it.

You need four values:

| Service key | `default-env.json` |
| --- | --- |
| `uaa.url` | `DOX_UAA_URL` |
| `uaa.clientid` | `DOX_UAA_CLIENTID` |
| `uaa.clientsecret` | `DOX_UAA_CLIENTSECRET` |
| `url` | `DOX_URL` |

The Document AI UI, where the schema was created, is the subscription. This app calls the service instance.

## 2. Local credentials

```bash
cp default-env.sample.json default-env.json
```

Fill in the service key. `default-env.json` is gitignored. On Cloud Foundry the app reads the same fields from `VCAP_SERVICES`.

`DOX_CLIENT` is the Document AI client inside the extraction options. Trial and most subaccounts use `default`. It is not the XSUAA client id.

The service key that used to be hardcoded in `srv/dox.js` has been removed from the source. Rotate it in BTP if this repository was shared. That trial authentication host currently returns 404, so use a service key from the subaccount you are working in now.

## 3. Schema and template

In Document AI, open Schema Configuration and confirm `ZSFL_GST_Invoice` is active. The first activated version is `1`. Note the document type. A schema you created as Custom must be sent as `custom`. A copy of the SAP invoice schema is sent as `invoice`.

Custom fields with setup type `manual` return values only after you create a template from a sample invoice and activate it. Put that template name in Request options on the page, or in `DOX_TEMPLATE`.

Save your export as `schema/ZSFL_GST_Invoice_schema.json`, or use Load schema export on the page. The page uses the file until it can read the live list. BTP extracts with the schema you select.

## Choose a schema

When `default-env.json` has a working service key, the Schema menu calls `GET /schemas` and lists the schemas in your Document AI client. Choosing one calls `GET /schemas/{id}` and switches the header and line-item columns to that schema. Invoice and letter of credit are two entries in the same list. Names that start with `SAP_` stay hidden until you tick Show SAP standard schemas.

## 4. Run

```bash
npm install
npm start
```

Open http://localhost:4004.

Keep this page on your machine while you are learning. It can spend your Document AI quota, and it is not protected by a login.

Use Test connection before the first invoice. A success message means XSUAA accepted the service key.

## 5. Extract

1. Drop a PDF, PNG, JPEG, or TIFF invoice on the page. Trial extraction is most reliable with a PDF or a single-page PNG or JPEG, up to 20 MB.
2. Open Request options and confirm schema name, version, document type, and template.
3. Press Extract invoice.

The server requests a client-credentials token, then sends:

```json
{
  "clientId": "default",
  "documentType": "custom",
  "schemaName": "ZSFL_GST_Invoice",
  "schemaVersion": "1",
  "templateName": "your-template"
}
```

`templateName` is omitted until you set one. A template id (a UUID) is sent as `templateId`.

The upload is `POST {service}/document/jobs` as multipart form data with parts `file` and `options`. The page then polls `GET {service}/document/jobs/{id}?extractedValues=true` until the status is `DONE`.

## 6. Read the tables

- Header rows follow the schema. The small text under each label is the technical field name Document AI returns.
- Supplier, buyer, invoice, and tax groups come from the schema.
- Line items are one row per extracted line. Amount columns are totaled.
- Confidence is the model's score from 0 to 1. Green is 90% or higher, orange is 75% to 89%, and red is below 75%.
- An empty cell means the schema asked for that field and the model did not return it. For a manual schema, that usually means the template does not mark the field yet.

Preview sample loads a fictional invoice (Northwind Components to Contoso Retail, `ZSFL/26-27/0148`) so the tables can be reviewed without BTP.

## What can be added next

- Save a confirmed header and its lines on the CAP invoice entity.
- Correct a field and send the correction back to Document AI.
- Keep a list of recent jobs.

`npm test` checks schema parsing, the sample totals, and how live extraction results are mapped onto the schema.
