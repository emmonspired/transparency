![](https://raw.githubusercontent.com/decentraland/web/gh-pages/img/decentraland.ico)

# Transparency

[Decentraland](https://decentraland.org)'s [Transparency Dashboard](https://transparency.decentraland.org)

To help our community better understand the MANA token, our transparency dashboard includes a summary of the most important stats, such as total supply, circulating supply, and how these may be affected by the aforementioned (and all future) MANA burn, as well as by vesting contracts.

<img width="1256" alt="screen shot 2018-02-16 at 5 02 15 pm" src="https://user-images.githubusercontent.com/2781777/36326813-33f747b4-133b-11e8-9031-9600b1dc7af9.png">

## Running the project

* `npm install`

* `npm start`

The script `npm start` will crawl the blockchain to gather all the necesary data, and finally it will output a `dashboard.html` file, and it will try to upload it to Amazon S3.

In order to upload to Amazon S3 you will need to configure the `S3_ACCESS_KEY` and `S3_SECRET_KEY` environment variables.

By default the script will try to connect to a public Infura node, but if you are running an Ethereum node locally, you can point to it from the `config.yaml` file by changing the `ethnode` property.
