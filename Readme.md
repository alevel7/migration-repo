## setup

- install nodejs
- install packages
- install typescript


run `npm install` to install packages
run `npm install -g typescript` to install typescript globally
run `tsc` to compile typescript files to javascript files

export MONGODB_URI=`mongodburl`

e.g export MONGODB_URI=


then run `node json_processor.js path-to-json-file database-name` 

e.g

node json_processor.js ./full_emr_clean.json smartclinic