import got from "got";
import { google } from "googleapis";
import config from "./config";

export const fetchIdToken = async function (aud: string): Promise<string> {
  const metadataServerTokenURL = `http://metadata/computeMetadata/v1/instance/service-accounts/default/identity?audience=${aud}`;

  let resp;
  try {
    resp = await got(metadataServerTokenURL, {
      headers: {
        "Metadata-Flavor": "Google",
      },
    });
  } catch (err) {
    console.error(err);
    throw new Error("Failed to fetch ID token from Google metadata endpoint");
  }

  const token = resp.body;
  if (!token) {
    throw new Error("ID token from Google metadata endpoint is empty");
  }

  return token;
};

export const buildSheetsClient = async () => {
  const auth = new google.auth.GoogleAuth({
    // Scopes can be specified either as an array or as a single, space-delimited string.
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });

  // Acquire an auth client, and bind it to all future calls
  const authClient = await auth.getClient();
  google.options({ auth: authClient });

  const fetchSheetData = async (): Promise<void> => {
    // TODO
    try {
      const sheets = google.sheets({ version: "v4" });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: config.sheetsSpreadsheetId,
        range: config.sheetsRange,
      });

      console.log("res", res);
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  return {
    fetchSheetData,
  };
};


/*
def fetch_sheet_data(service: Resource) -> list[SheetsRow]:
    logging.info("Calling Sheets API to fetch data...")
    sheet = service.spreadsheets()
    result = (
        sheet.values()
        .get(
            spreadsheetId=getenv("SHEETS_SPREADSHEET_ID"),
            range=getenv("SHEETS_RANGE"),
        )
        .execute()
    )

    rows = result.get("values", [])
    logging.info(f"Fetched {len(rows)} rows of data")
    return [_row_to_dataclass(row) for row in rows]


def update_sheet_last_done_column(service: Resource, new_datestamps: list[str]):
    logging.info("Calling Sheets API to update last done column...")
    range = getenv("SHEETS_RANGE")
    sheet = service.spreadsheets()
    last_done_column_range = _get_rightmost_column_in_range(range)

    body = {"values": [[datestamp] for datestamp in new_datestamps]}

    sheet.values().update(
        spreadsheetId=getenv("SHEETS_SPREADSHEET_ID"),
        range=last_done_column_range,
        valueInputOption="RAW",
        body=body,
    ).execute()
*/