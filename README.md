# Invoice extraction with SAP AI Core

A Fiori Horizon style page that sends an invoice to a model deployed in SAP AI Core and shows the header and line items in tables. The columns come from the schema JSON files in `schema/`. The GST schema is `schema/ZSFL_GST_Invoice_schema.json`.

SAP AI Core does not store Document AI schemas. The same schema export is the contract: the app puts those field names in the prompt, and the tables render whatever the model returns. Preview sample works before a service key is configured and does not call SAP AI Core.

## 1. Entitle the extended plan

Generative AI Hub is available on the SAP AI Core **extended** plan. The free and standard plans do not include it.

1. Open the global account and go to Entitlements.
2. Choose Configure Entitlements, then Add Service Plans.
3. Select SAP AI Core and the `extended` plan, then assign it to the subaccount you will use.
4. Also entitle SAP AI Launchpad and subscribe to it in that subaccount. The booster under Boosters does both the subscription and the AI Core instance.

## 2. Create the service instance and service key

1. In the subaccount, open Instances and Subscriptions.
2. Create a service instance of SAP AI Core with plan `extended` if the booster did not create one.
3. Create a service key and download it.

Copy these fields into `default-env.json`:

| Service key | `default-env.json` |
| --- | --- |
| `url` | `AICORE_AUTH_URL` |
| `clientid` | `AICORE_CLIENT_ID` |
| `clientsecret` | `AICORE_CLIENT_SECRET` |
| `serviceurls.AI_API_URL` | `AICORE_BASE_URL` |

```bash
cp default-env.sample.json default-env.json
```

`default-env.json` is gitignored. On Cloud Foundry the app reads the same fields from a service binding whose label contains `aicore`. Do not commit the client secret.

The instance creates a resource group named `default`. Leave `AICORE_RESOURCE_GROUP` as `default` unless you created another group. A model deployment belongs to one resource group.

## 3. Deploy a chat model that can see images

Open SAP AI Launchpad with a user that has `mloperations_editor` or `genai_manager`. Those roles are for creating the deployment. The app's service key uses client credentials and does not need them.

1. Select the SAP AI Core runtime and the `default` resource group.
2. Open ML Operations, then Scenarios. Confirm `foundation-models` is listed. If it is missing, the instance is not on the extended plan.
3. Open Configurations and create one:
   - Scenario: `foundation-models`
   - Version: the latest version shown
   - Executable: `azure-openai` for GPT models, or the executable Launchpad shows for the provider you chose
   - Parameter `modelName`: `gpt-4o`
   - Parameter `modelVersion`: `latest`
4. Create a deployment from that configuration. Duration: Standard.
5. Wait until the status is RUNNING.
6. Copy the deployment ID from the deployment URL into `AICORE_DEPLOYMENT_ID`.

`gpt-4o` can read a PNG or JPEG. A text-only model cannot read a photo or a scan. `modelVersion` `latest` follows the current model version. SAP Note 3437766 lists available models, versions, and deprecation dates.

Deploy the model itself. An orchestration deployment is a different endpoint. This app calls the model deployment's chat completions API, not orchestration.

The executable lists every model that provider can run, including `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, and `gpt-4.1-mini`. A deployment still serves only the `modelName` saved on its configuration. To change models from the page, create one configuration and one RUNNING deployment per model. The Model menu lists only those running chat deployments. Embedding, realtime, and undeployed models are left out.

Gemini chat models use the same menu and a separate deployment ID. Keep the GPT deployment in `AICORE_DEPLOYMENT_ID`. Put the Gemini deployment in `AICORE_GEMINI_DEPLOYMENT_ID`, and set `AICORE_GEMINI_MODEL` to the deployed model name, usually `gemini-2.5-flash`. The Model menu shows a running Gemini chat deployment beside the GPT deployment. Picking Gemini calls that deployment's `generateContent` endpoint. `gemini-embedding` is not listed, because it cannot read an invoice.

## 4. Schemas

Put one JSON export in `schema/` for each document type. The Schema menu lists those files. Choosing one loads its header and line-item columns and uses that field list in the prompt. The GST invoice and a letter of credit are two files. The model does not decide which schema to use.

Use Load schema export on the page to add another file, or copy the JSON into `schema/` and restart. The active choice is remembered in `schema/.active`, which is gitignored. The default file is `schema/ZSFL_GST_Invoice_schema.json`.

## 5. Run

```bash
npm install
npm start
```

Open http://localhost:4004.

Keep this page on your machine while you are learning. Each extraction calls the deployed model and can spend quota. The page is not protected by a login.

Use Test connection before the first invoice. A success message means the service key was accepted.

## 6. Extract

1. Choose the schema.
2. Drop a digital PDF, PNG, or JPEG. Up to 20 MB.
3. Choose a model when AI Core or Compare both is selected. Configured deployment uses `AICORE_DEPLOYMENT_ID`. Open Request options to use a different resource group.
4. Press Extract invoice.

A PDF is sent to the model with the field list, so the model reads the pages itself. If that deployment refuses a PDF attachment, the app reads the text from the file and sends the text instead. A PNG or JPEG is sent as an image. TIFF is not accepted.

## Compare Document AI and AI Core

The Source control has three choices:

- **AI Core** sends the file to the deployed model.
- **Document AI** sends the file to Document Information Extraction with the schema name, version, and optional template.
- **Both** runs the two extractions on the same file and shows one comparison. Matching values stay plain. Different values are highlighted. A service that is not configured is shown as an error on its side, and the other side is still displayed.

Document AI uses `DOX_UAA_URL`, `DOX_UAA_CLIENTID`, `DOX_UAA_CLIENTSECRET`, and `DOX_URL` from `default-env.json`, alongside the `AICORE_*` values. `DOX_CLIENT` is the Document AI client inside the extraction options, usually `default`. `DOX_TEMPLATE` is the activated template name when the schema fields use manual setup.

The server requests a client-credentials token, then sends:

```text
POST {AI_API_URL}/v2/inference/deployments/{deploymentId}/chat/completions?api-version=2023-05-15
Authorization: Bearer <token>
AI-Resource-Group: default
```

`AI_API_URL` is the service key value without a trailing `/v2`. The default API version is `2023-05-15`. Set `AICORE_API_VERSION` to `none` to omit the query parameter.

The model is asked to return JSON shaped as `header` and `lineItems`, keyed by the schema field names. Empty fields stay empty. The model is instructed not to invent GSTINs, totals, or line items.

## 7. Read the tables

- Header rows follow the schema. The small text under each label is the technical field name.
- Supplier, buyer, invoice, and tax groups come from the schema.
- Line items are one row per extracted line. Amount columns are totaled. The rate column is not summed.
- The confidence score is the model's own estimate from 0 to 1. It is not a Document AI score. Green is 90% or higher, orange is 75% to 89%, and red is below 75%.
- An empty cell means the model did not find that field on the document.

Preview sample loads a fictional invoice (Northwind Components to Contoso Retail, `ZSFL/26-27/0148`) so the tables can be reviewed without SAP AI Core.

## What can be added next

- Save a confirmed header and its lines on the CAP invoice entity.
- Keep a list of recent extractions.

`npm test` checks schema parsing, the sample totals, how extraction results are mapped onto the schema, and how the model JSON is mapped onto the same fields.
